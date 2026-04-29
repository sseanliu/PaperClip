/**
 * app.js — PaperClip new tab page.
 *
 * Renders a Zotero-style library of every paper that's been auto-captured
 * by the service worker. Reads chrome.storage.local.papers and chrome.tabs
 * to mark which papers are currently open.
 *
 * The classifier (classifyPaper) comes from papers.js, loaded ahead of this
 * script in index.html.
 */

const PAPERS_KEY = 'papers';

const SOURCE_LABELS = {
  arxiv: 'arXiv',
  openreview: 'OpenReview',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  acm: 'ACM',
  ieee: 'IEEE',
  springer: 'Springer',
  nature: 'Nature',
  science: 'Science',
  nips: 'NeurIPS',
  mlr: 'PMLR',
  acl: 'ACL Anthology',
  semanticscholar: 'Semantic Scholar',
  pdf: 'PDF',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now = new Date();
  const diffMins = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays = Math.floor((now - then) / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return diffDays + ' days ago';
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return diffMonths + ' mo ago';
  const diffYears = Math.floor(diffDays / 365);
  return diffYears + ' yr' + (diffYears !== 1 ? 's' : '') + ' ago';
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function fallbackTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Data access ──────────────────────────────────────────────────────────────

async function getPapers() {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  return store[PAPERS_KEY] || {};
}

async function getOpenPaperMap() {
  const tabs = await chrome.tabs.query({});
  const map = new Map(); // canonicalId → tab
  for (const t of tabs) {
    if (!t.url) continue;
    const cls = classifyPaper(t.url);
    if (cls) map.set(cls.canonicalId, t);
  }
  return map;
}

// ─── Filtering / sorting ──────────────────────────────────────────────────────

function paperMatchesFilter(p, q) {
  if (!q) return true;
  const hay = [
    p.title,
    (p.authors || []).join(' '),
    p.venue,
    p.year,
    SOURCE_LABELS[p.source] || p.source,
    p.url,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function sortPapers(list, openMap) {
  return list.slice().sort((a, b) => {
    const ao = openMap.has(a.id) ? 1 : 0;
    const bo = openMap.has(b.id) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '');
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderRow(p, openMap) {
  const open = openMap.get(p.id);
  const isOpen = !!open;

  const title = p.title || fallbackTitle('') || p.url;

  const authorsList = Array.isArray(p.authors) ? p.authors.filter(Boolean) : [];
  const authorsStr = authorsList.length === 0
    ? ''
    : authorsList.length <= 3
      ? authorsList.join(', ')
      : authorsList.slice(0, 3).join(', ') + ' et al.';

  const metaParts = [
    authorsStr,
    p.year ? String(p.year) : '',
    p.venue || '',
    SOURCE_LABELS[p.source] || p.source || '',
  ].filter(Boolean);

  const subParts = [
    timeAgo(p.lastSeenAt),
    (p.visitCount && p.visitCount > 1) ? `${p.visitCount} visits` : null,
  ].filter(Boolean);

  return `
    <div class="paper-row${isOpen ? ' is-open' : ''}"
         data-id="${escapeHtml(p.id)}"
         data-url="${escapeHtml(p.url)}"
         ${open ? `data-tab-id="${open.id}" data-window-id="${open.windowId}"` : ''}>
      <div class="paper-dot" aria-hidden="true"></div>
      <div class="paper-main">
        <div class="paper-title">${escapeHtml(title)}</div>
        ${metaParts.length ? `<div class="paper-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
        <div class="paper-sub">${escapeHtml(subParts.join(' · '))}</div>
      </div>
      <button class="paper-open-btn"
              data-action="open-new-tab"
              title="Open in new tab"
              aria-label="Open in new tab">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 17 17 7"/>
          <path d="M8 7h9v9"/>
        </svg>
      </button>
    </div>
  `;
}

async function renderLibrary(filter = '') {
  const list = document.getElementById('paperList');
  const countEl = document.getElementById('paperCount');
  const emptyEl = document.getElementById('paperEmpty');
  if (!list) return;

  const [papers, openMap] = await Promise.all([getPapers(), getOpenPaperMap()]);
  const all = Object.values(papers);

  const q = filter.trim().toLowerCase();
  const filtered = q ? all.filter(p => paperMatchesFilter(p, q)) : all;
  const sorted = sortPapers(filtered, openMap);

  if (all.length === 0) {
    list.innerHTML = '';
    emptyEl.style.display = 'flex';
    emptyEl.querySelector('[data-empty-state="initial"]').style.display = 'block';
    emptyEl.querySelector('[data-empty-state="no-results"]').style.display = 'none';
    countEl.textContent = '';
    return;
  }

  if (sorted.length === 0) {
    list.innerHTML = '';
    emptyEl.style.display = 'flex';
    emptyEl.querySelector('[data-empty-state="initial"]').style.display = 'none';
    emptyEl.querySelector('[data-empty-state="no-results"]').style.display = 'block';
    countEl.textContent = `0 of ${all.length}`;
    return;
  }

  emptyEl.style.display = 'none';
  countEl.textContent = q
    ? `${sorted.length} of ${all.length}`
    : `${all.length} paper${all.length === 1 ? '' : 's'}`;
  list.innerHTML = sorted.map(p => renderRow(p, openMap)).join('');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-action="open-new-tab"]');
  if (openBtn) {
    e.stopPropagation();
    e.preventDefault();
    const row = openBtn.closest('.paper-row');
    if (row && row.dataset.url) chrome.tabs.create({ url: row.dataset.url });
    return;
  }

  const row = e.target.closest('.paper-row');
  if (!row) return;
  const tabId = row.dataset.tabId ? parseInt(row.dataset.tabId, 10) : null;
  const windowId = row.dataset.windowId ? parseInt(row.dataset.windowId, 10) : null;

  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (windowId) await chrome.windows.update(windowId, { focused: true });
      return;
    } catch {
      // tab disappeared between render and click — fall through to open a new one
    }
  }
  if (row.dataset.url) chrome.tabs.create({ url: row.dataset.url });
});

let searchDebounce;
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'paperSearch') {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderLibrary(e.target.value), 100);
  }
});

// Re-render whenever the service worker writes new papers / enrichment.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PAPERS_KEY]) return;
  const search = document.getElementById('paperSearch');
  renderLibrary(search ? search.value : '');
});

// Re-render on tab open/close so the open-status dots stay accurate.
if (chrome.tabs && chrome.tabs.onCreated && chrome.tabs.onRemoved) {
  const refreshOpenState = () => {
    const search = document.getElementById('paperSearch');
    renderLibrary(search ? search.value : '');
  };
  chrome.tabs.onCreated.addListener(refreshOpenState);
  chrome.tabs.onRemoved.addListener(refreshOpenState);
  chrome.tabs.onUpdated.addListener((_, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) refreshOpenState();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  const greeting = document.getElementById('greeting');
  const date = document.getElementById('dateDisplay');
  if (greeting) greeting.textContent = getGreeting();
  if (date) date.textContent = getDateDisplay();
  renderLibrary();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
