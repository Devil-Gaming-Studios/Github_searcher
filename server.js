import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---- Simple in-memory cache so repeated searches don't burn rate limit ----
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { value, time: Date.now() });
}

// ---- Activity scoring ----
// We only use fields already returned by the GitHub Search API (no extra
// per-repo requests), so this stays fast and works fine without a token.
function daysSince(dateString) {
  const then = new Date(dateString).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

function recencyScore(days) {
  if (days <= 1) return 100;
  if (days <= 7) return 85;
  if (days <= 30) return 65;
  if (days <= 90) return 40;
  if (days <= 180) return 20;
  if (days <= 365) return 8;
  return 0;
}

function popularityScore(stars, forks) {
  // log scale so mega-repos (50k+ stars) don't completely drown out
  // smaller but genuinely active projects.
  return Math.log10(stars + 1) * 12 + Math.log10(forks + 1) * 6;
}

function scoreRepo(repo) {
  const days = daysSince(repo.pushed_at);
  const recency = recencyScore(days);
  const popularity = popularityScore(repo.stargazers_count, repo.forks_count);
  // Recency is weighted higher than raw popularity because "most active"
  // should mean "still being worked on", not just "well known".
  const activityScore = Math.round(recency * 1.6 + popularity);
  return { days, activityScore };
}

function buildQuery({ topic, language }) {
  const cleanTopic = topic.trim().toLowerCase().replace(/["\s]+/g, '-');
  let q = `topic:${cleanTopic}`;
  if (language && language.trim()) {
    q += ` language:${language.trim().replace(/["\s]+/g, '-')}`;
  }
  return q;
}

async function searchGithub(query) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query
  )}&sort=stars&order=desc&per_page=40`;

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'repo-observatory-app',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  const remaining = res.headers.get('x-ratelimit-remaining');
  const resetAt = res.headers.get('x-ratelimit-reset');

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `GitHub API error (${res.status})`);
    err.status = res.status;
    err.rateLimitRemaining = remaining;
    err.rateLimitReset = resetAt;
    throw err;
  }

  const data = await res.json();
  return { data, remaining, resetAt };
}

app.get('/api/search', async (req, res) => {
  const topic = (req.query.topic || '').toString().trim();
  const language = (req.query.language || '').toString().trim();
  const sort = (req.query.sort || 'active').toString();

  if (!topic) {
    return res.status(400).json({ error: 'A topic is required, e.g. ?topic=machine-learning' });
  }
  if (topic.length > 50) {
    return res.status(400).json({ error: 'Topic is too long.' });
  }

  const query = buildQuery({ topic, language });
  const cacheKey = `${query}::${sort}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const { data, remaining, resetAt } = await searchGithub(query);

    let repos = (data.items || []).map((repo) => {
      const { days, activityScore } = scoreRepo(repo);
      return {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner?.login,
        ownerAvatar: repo.owner?.avatar_url,
        htmlUrl: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        language: repo.language,
        pushedAt: repo.pushed_at,
        daysSincePush: Math.round(days),
        activityScore,
      };
    });

    if (sort === 'active') {
      repos.sort((a, b) => b.activityScore - a.activityScore);
    } else {
      repos.sort((a, b) => b.stars - a.stars);
    }

    repos = repos.slice(0, 12);

    const payload = {
      topic,
      language: language || null,
      sort,
      query,
      totalMatches: data.total_count,
      count: repos.length,
      generatedAt: new Date().toISOString(),
      rateLimitRemaining: remaining ? Number(remaining) : null,
      repos,
    };

    setCached(cacheKey, payload);
    res.json({ ...payload, cached: false });
  } catch (err) {
    if (err.status === 403) {
      const resetDate = err.rateLimitReset
        ? new Date(Number(err.rateLimitReset) * 1000).toLocaleTimeString()
        : 'soon';
      return res.status(429).json({
        error: `GitHub API rate limit reached. It resets around ${resetDate}. Add a GITHUB_TOKEN in .env to raise this limit.`,
      });
    }
    if (err.status === 422) {
      return res.status(422).json({ error: 'That topic produced an invalid search query. Try a simpler term.' });
    }
    console.error(err);
    res.status(502).json({ error: 'Could not reach GitHub right now. Try again in a moment.' });
  }
});

app.listen(PORT, () => {
  console.log(`Repo Observatory running at http://localhost:${PORT}`);
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN set — using unauthenticated GitHub API (60 requests/hour).');
  }
});
