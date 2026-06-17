import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---- Safely read the token without ever letting it leak into errors/logs ----
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
if (!GITHUB_TOKEN) {
  console.warn(
    '[WARN] No GITHUB_TOKEN set — unauthenticated GitHub API (60 req/hour).'
  );
}

// ---- Optional API key guard -----------------------------------------------
// Set API_KEY in your .env to require callers to pass it as
//   X-Api-Key: <value>
// Leave it unset to disable the check (e.g. during local dev).
const API_KEY = process.env.API_KEY || '';

function apiKeyMiddleware(req, res, next) {
  if (!API_KEY) return next(); // guard disabled
  const provided = req.headers['x-api-key'] || '';
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-Api-Key header.' });
  }
  next();
}

// ---- Input allowlists -------------------------------------------------------
// Only a-z, 0-9, hyphens, dots — matches what GitHub topic slugs actually allow.
const SAFE_SLUG = /^[a-z0-9][a-z0-9\-.]{0,48}[a-z0-9]$|^[a-z0-9]$/i;
const VALID_SORTS = new Set(['active', 'stars']);

// ---- Rate limiter -----------------------------------------------------------
// 30 requests per 15-minute window per IP — tune as needed.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a few minutes and try again.' },
});

// ---- Bounded LRU cache (max 200 entries, 5-min TTL) ------------------------
const cache = new LRUCache({
  max: 200,
  ttl: 5 * 60 * 1000,
});

// ---- Activity scoring -------------------------------------------------------
function daysSince(dateString) {
  return (Date.now() - new Date(dateString).getTime()) / (1000 * 60 * 60 * 24);
}

function recencyScore(days) {
  if (days <= 1)   return 100;
  if (days <= 7)   return 85;
  if (days <= 30)  return 65;
  if (days <= 90)  return 40;
  if (days <= 180) return 20;
  if (days <= 365) return 8;
  return 0;
}

function popularityScore(stars, forks) {
  return Math.log10(stars + 1) * 12 + Math.log10(forks + 1) * 6;
}

function scoreRepo(repo) {
  const days = daysSince(repo.pushed_at);
  const activityScore = Math.round(recencyScore(days) * 1.6 + popularityScore(repo.stargazers_count, repo.forks_count));
  return { days, activityScore };
}

// ---- Query builder ----------------------------------------------------------
function buildQuery({ topic, language }) {
  let q = `topic:${topic}`;
  if (language) q += ` language:${language}`;
  return q;
}

// ---- GitHub fetch -----------------------------------------------------------
async function searchGithub(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=40`;

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'repo-observatory-app',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Token is injected here only — never serialised into responses or logs.
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  const remaining = res.headers.get('x-ratelimit-remaining');
  const resetAt   = res.headers.get('x-ratelimit-reset');

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Strip any accidental token echo from GitHub's error body
    const message = (body.message || `GitHub API error (${res.status})`).replace(GITHUB_TOKEN || '~~NOOP~~', '[REDACTED]');
    const err = new Error(message);
    err.status = res.status;
    err.rateLimitReset = resetAt;
    throw err;
  }

  return { data: await res.json(), remaining, resetAt };
}

// ---- Routes -----------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/search', limiter, apiKeyMiddleware, async (req, res) => {
  // --- Validate topic --------------------------------------------------------
  const rawTopic = (req.query.topic || '').toString().trim().toLowerCase();
  if (!rawTopic) {
    return res.status(400).json({ error: 'A topic is required, e.g. ?topic=machine-learning' });
  }
  if (!SAFE_SLUG.test(rawTopic)) {
    return res.status(400).json({ error: 'Topic must contain only letters, numbers, hyphens, or dots (2–50 chars).' });
  }

  // --- Validate language (optional) -----------------------------------------
  const rawLang = (req.query.language || '').toString().trim().toLowerCase();
  if (rawLang && !SAFE_SLUG.test(rawLang)) {
    return res.status(400).json({ error: 'Language contains invalid characters.' });
  }

  // --- Validate sort ---------------------------------------------------------
  const rawSort = (req.query.sort || 'active').toString().trim().toLowerCase();
  if (!VALID_SORTS.has(rawSort)) {
    return res.status(400).json({ error: `Invalid sort value. Allowed: ${[...VALID_SORTS].join(', ')}.` });
  }

  const query    = buildQuery({ topic: rawTopic, language: rawLang || null });
  const cacheKey = `${query}::${rawSort}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const { data, remaining, resetAt } = await searchGithub(query);

    let repos = (data.items || []).map((repo) => {
      const { days, activityScore } = scoreRepo(repo);
      return {
        id:            repo.id,
        name:          repo.name,
        fullName:      repo.full_name,
        owner:         repo.owner?.login,
        ownerAvatar:   repo.owner?.avatar_url,
        htmlUrl:       repo.html_url,
        description:   repo.description,
        stars:         repo.stargazers_count,
        forks:         repo.forks_count,
        openIssues:    repo.open_issues_count,
        language:      repo.language,
        pushedAt:      repo.pushed_at,
        daysSincePush: Math.round(days),
        activityScore,
      };
    });

    repos.sort((a, b) =>
      rawSort === 'active' ? b.activityScore - a.activityScore : b.stars - a.stars
    );
    repos = repos.slice(0, 12);

    const payload = {
      topic:               rawTopic,
      language:            rawLang || null,
      sort:                rawSort,
      query,
      totalMatches:        data.total_count,
      count:               repos.length,
      generatedAt:         new Date().toISOString(),
      rateLimitRemaining:  remaining != null ? Number(remaining) : null,
      repos,
    };

    cache.set(cacheKey, payload);
    return res.json({ ...payload, cached: false });

  } catch (err) {
    if (err.status === 403) {
      const resetDate = err.rateLimitReset
        ? new Date(Number(err.rateLimitReset) * 1000).toLocaleTimeString()
        : 'soon';
      return res.status(429).json({
        error: `GitHub API rate limit reached. Resets around ${resetDate}. Add a GITHUB_TOKEN in .env to raise this limit.`,
      });
    }
    if (err.status === 422) {
      return res.status(422).json({ error: 'That topic produced an invalid GitHub search query. Try a simpler term.' });
    }
    // Never forward raw error messages — they could contain internal details.
    console.error('[ERROR] GitHub search failed:', err.message);
    return res.status(502).json({ error: 'Could not reach GitHub right now. Try again in a moment.' });
  }
});

app.listen(PORT, () => {
  console.log(`Repo Observatory running at http://localhost:${PORT}`);
});