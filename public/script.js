const form = document.getElementById('search-form');
const topicInput = document.getElementById('topic');
const languageInput = document.getElementById('language');
const grid = document.getElementById('grid');
const metaLine = document.getElementById('meta-line');
const errorBox = document.getElementById('error-box');
const sortButtons = document.querySelectorAll('.pill');
const chips = document.querySelectorAll('.chip');
cinst fake install

let currentSort = 'active';

function setSort(sort) {
  currentSort = sort;
  sortButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.sort === sort);
  });
}

sortButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    setSort(btn.dataset.sort);
    if (topicInput.value.trim()) runSearch();
  });
});

chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    topicInput.value = chip.dataset.topic;
    runSearch();
  });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

function showEmpty(message) {
  grid.innerHTML = `<div class="empty-state">${message}</div>`;
}

function showLoading() {
  grid.innerHTML = `<div class="loading-state">Scanning GitHub for matching repositories…</div>`;
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function timeAgo(days) {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.round(days / 365);
  return `${years} yr ago`;
}

function formatCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function renderRepos(repos) {
  if (!repos.length) {
    showEmpty('No repositories matched that topic. Try a broader or differently spelled term.');
    return;
  }

  const maxScore = Math.max(...repos.map((r) => r.activityScore), 1);

  grid.innerHTML = repos
    .map((repo, i) => {
      const normalized = Math.max(repo.activityScore / maxScore, 0.12);
      const glowSize = (10 + normalized * 16).toFixed(1);
      const glowOpacity = (0.5 + normalized * 0.5).toFixed(2);

      return `
        <a class="card" href="${repo.htmlUrl}" target="_blank" rel="noopener noreferrer" style="animation-delay: ${i * 35}ms">
          <div class="card-top">
            <span class="glow" style="width:${glowSize}px;height:${glowSize}px;opacity:${glowOpacity}"></span>
            <span class="rank">No. ${i + 1}</span>
          </div>
          <div class="repo-name"><span class="owner">${escapeHtml(repo.owner)}/</span>${escapeHtml(repo.name)}</div>
          <div class="repo-desc">${escapeHtml(repo.description || 'No description provided.')}</div>
          <div class="stat-row">
            <span>★ ${formatCount(repo.stars)}</span>
            <span>⑂ ${formatCount(repo.forks)}</span>
            <span>pushed ${timeAgo(repo.daysSincePush)}</span>
            ${repo.language ? `<span><span class="lang-dot"></span>${escapeHtml(repo.language)}</span>` : ''}
          </div>
        </a>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function runSearch() {
  const topic = topicInput.value.trim();
  if (!topic) {
    topicInput.focus();
    return;
  }

  hideError();
  showLoading();
  metaLine.textContent = '';

  const params = new URLSearchParams({ topic, sort: currentSort });
  const language = languageInput.value.trim();
  if (language) params.set('language', language);

  try {
    const res = await fetch(`/api/search?${params.toString()}`, {
  headers: { 'X-Api-Key': 'bkguyguyfuvdr6etufry6dertyfvyretyf 7vre67gbyufr6ew' }
  }); 
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Something went wrong fetching results.');
      showEmpty('No results to show.');
      return;
    }

    renderRepos(data.repos);

    const sortLabel = currentSort === 'active' ? 'activity' : 'star count';
    metaLine.textContent = `Surveying "${data.topic}"${data.language ? ` + ${data.language}` : ''} — ${data.totalMatches.toLocaleString()} repositories found, showing top ${data.count} by ${sortLabel}${data.cached ? ' (cached)' : ''}.`;
  } catch (err) {
    showError('Could not reach the server. Check your connection and try again.');
    showEmpty('No results to show.');
  }
}
