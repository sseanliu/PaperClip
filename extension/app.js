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

function looksLikeUrlOrFilename(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(t) && !/\s/.test(t)) return true;
  if (/^[\w.-]+\.pdf$/i.test(t)) return true;
  return false;
}

function fallbackTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayTitle(p) {
  const t = p.title || '';
  if (t && !looksLikeUrlOrFilename(t)) return t;
  // Title was stored before our placeholder fix, or the page just gave us
  // its URL. Show a friendly placeholder using the source + ID.
  if (p.sourceId) {
    const label = SOURCE_LABELS[p.source] || p.source || '';
    return `${label}:${p.sourceId}`;
  }
  return t || p.url;
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

function sortPapers(list) {
  // Sort purely by when the paper was first added to the library — newest at
  // top. Open-tab status doesn't affect order; revisits don't either.
  return list.slice().sort((a, b) => {
    return (b.firstSeenAt || '').localeCompare(a.firstSeenAt || '');
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderRow(p, openMap) {
  const open = openMap.get(p.id);
  const isOpen = !!open;
  const isRead = p.readStatus === 'read';

  const title = displayTitle(p);

  const authorsList = Array.isArray(p.authors) ? p.authors.filter(Boolean) : [];
  const authorsStr = authorsList.length === 0
    ? ''
    : authorsList.length <= 3
      ? authorsList.join(', ')
      : authorsList.slice(0, 3).join(', ') + ' et al.';

  const sourceLabel = SOURCE_LABELS[p.source] || p.source || '';
  const hasRealMeta = authorsList.length > 0 || p.year || p.venue;

  // Sub-line below title: source · venue · time ago · visits · status
  const subParts = [];
  if (sourceLabel) subParts.push(escapeHtml(sourceLabel));
  if (p.venue) subParts.push(escapeHtml(p.venue));
  subParts.push(escapeHtml(timeAgo(p.lastSeenAt)));
  if (p.visitCount && p.visitCount > 1) subParts.push(escapeHtml(`${p.visitCount} visits`));

  if (!hasRealMeta) {
    if (p.enrichmentStatus === 'pending') {
      subParts.push('<span class="paper-status paper-status-pending"><span class="paper-status-dot"></span>fetching metadata</span>');
    } else if (p.enrichmentStatus === 'failed') {
      subParts.push('<span class="paper-status paper-status-failed">metadata unavailable · will retry</span>');
    }
  }

  const classes = ['paper-row'];
  if (isOpen) classes.push('is-open');
  if (isRead) classes.push('is-read');

  return `
    <div class="${classes.join(' ')}"
         data-id="${escapeHtml(p.id)}"
         data-url="${escapeHtml(p.url)}"
         ${open ? `data-tab-id="${open.id}" data-window-id="${open.windowId}"` : ''}>
      <div class="paper-dot" aria-hidden="true"></div>
      <div class="paper-main">
        <div class="paper-title">${escapeHtml(title)}</div>
        <div class="paper-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="paper-col-authors">${authorsStr ? escapeHtml(authorsStr) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-col-year">${p.year ? escapeHtml(String(p.year)) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-actions">
        <button class="paper-icon-btn paper-read-btn"
                data-action="toggle-read"
                title="${isRead ? 'Mark as unread' : 'Mark as read'}"
                aria-label="${isRead ? 'Mark as unread' : 'Mark as read'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </button>
        <button class="paper-icon-btn paper-open-btn"
                data-action="open-new-tab"
                title="Open in new tab"
                aria-label="Open in new tab">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 17 17 7"/>
            <path d="M8 7h9v9"/>
          </svg>
        </button>
        <button class="paper-icon-btn paper-delete-btn"
                data-action="delete"
                title="Remove from library"
                aria-label="Remove from library">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

async function renderLibrary(filter = '') {
  const list = document.getElementById('paperList');
  const header = document.getElementById('paperListHeader');
  const countEl = document.getElementById('paperCount');
  const emptyEl = document.getElementById('paperEmpty');
  if (!list) return;

  const [papers, openMap] = await Promise.all([getPapers(), getOpenPaperMap()]);
  const all = Object.values(papers);

  const q = filter.trim().toLowerCase();
  const filtered = q ? all.filter(p => paperMatchesFilter(p, q)) : all;
  const sorted = sortPapers(filtered);

  if (all.length === 0) {
    list.innerHTML = '';
    if (header) header.style.display = 'none';
    emptyEl.style.display = 'flex';
    emptyEl.querySelector('[data-empty-state="initial"]').style.display = 'block';
    emptyEl.querySelector('[data-empty-state="no-results"]').style.display = 'none';
    countEl.textContent = '';
    return;
  }

  if (sorted.length === 0) {
    list.innerHTML = '';
    if (header) header.style.display = 'none';
    emptyEl.style.display = 'flex';
    emptyEl.querySelector('[data-empty-state="initial"]').style.display = 'none';
    emptyEl.querySelector('[data-empty-state="no-results"]').style.display = 'block';
    countEl.textContent = `0 of ${all.length}`;
    return;
  }

  emptyEl.style.display = 'none';
  if (header) header.style.display = 'grid';
  countEl.textContent = q
    ? `${sorted.length} of ${all.length}`
    : `${all.length} paper${all.length === 1 ? '' : 's'}`;
  list.innerHTML = sorted.map(p => renderRow(p, openMap)).join('');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

async function patchPaper(id, mutate) {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  if (!papers[id]) return;
  mutate(papers[id]);
  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

async function deletePaper(id) {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  if (!papers[id]) return;
  delete papers[id];
  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

document.addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    const row = actionBtn.closest('.paper-row');
    if (!row) return;
    e.stopPropagation();
    e.preventDefault();

    if (action === 'open-new-tab') {
      if (row.dataset.url) chrome.tabs.create({ url: row.dataset.url });
      return;
    }
    if (action === 'toggle-read') {
      await patchPaper(row.dataset.id, p => {
        p.readStatus = p.readStatus === 'read' ? 'unread' : 'read';
      });
      return;
    }
    if (action === 'delete') {
      await deletePaper(row.dataset.id);
      return;
    }
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

  // Ask the service worker to scan all currently-open tabs and add any
  // papers we don't have yet. Storage.onChanged will trigger a re-render
  // when new entries land, so the user sees them appear without refreshing.
  if (chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: 'paperclip:backfill' });
    } catch {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
