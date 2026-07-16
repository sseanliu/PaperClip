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
const TAGS_KEY = 'tags';

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
  cvf: 'CVF',
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

async function getTags() {
  const store = await chrome.storage.local.get(TAGS_KEY);
  return store[TAGS_KEY] || {};
}

async function saveTags(tags) {
  await chrome.storage.local.set({ [TAGS_KEY]: tags });
}

function genTagId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

async function createTag(rawName) {
  const name = (rawName || '').trim();
  if (!name) return null;
  const tags = await getTags();
  // Avoid creating an exact-name duplicate; reuse the existing one's id.
  const existing = Object.values(tags).find(
    t => t.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;
  const id = genTagId();
  tags[id] = { id, name, createdAt: new Date().toISOString() };
  await saveTags(tags);
  return id;
}

async function renameTagById(id, rawName) {
  const name = (rawName || '').trim();
  if (!name) return;
  const tags = await getTags();
  if (!tags[id]) return;
  tags[id].name = name;
  await saveTags(tags);
}

async function deleteTagById(id) {
  // Strip the tag from every paper, then remove the tag itself.
  // Single batched write so the UI sees a consistent snapshot.
  const store = await chrome.storage.local.get([PAPERS_KEY, TAGS_KEY]);
  const papers = store[PAPERS_KEY] || {};
  const tags = store[TAGS_KEY] || {};
  for (const p of Object.values(papers)) {
    if (Array.isArray(p.tags) && p.tags.includes(id)) {
      p.tags = p.tags.filter(t => t !== id);
    }
  }
  delete tags[id];
  await chrome.storage.local.set({ [PAPERS_KEY]: papers, [TAGS_KEY]: tags });
}

function countPapersWithTag(allPapers, tagId) {
  let n = 0;
  for (const p of allPapers) {
    if (Array.isArray(p.tags) && p.tags.includes(tagId)) n += 1;
  }
  return n;
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

// Sidebar filter state. type ∈ 'all' | 'starred' | 'untagged' | 'tag'.
// When 'tag', tagIds is a Set of tag IDs (OR'd together).
const activeFilter = { type: 'all', tagIds: new Set() };

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

function paperMatchesActiveTag(p) {
  switch (activeFilter.type) {
    case 'all':      return true;
    case 'starred':  return !!p.starred;
    case 'untagged': return !Array.isArray(p.tags) || p.tags.length === 0;
    case 'tag': {
      const tags = Array.isArray(p.tags) ? p.tags : [];
      for (const id of activeFilter.tagIds) {
        if (tags.includes(id)) return true;
      }
      return false;
    }
    default: return true;
  }
}

// Sort mode. 'added' orders by firstSeenAt (when the paper entered the
// library); 'opened' orders by lastSeenAt (most recent visit). Persisted
// across new-tab opens.
const SORT_MODE_KEY = 'paperclip-sort-mode';
let sortMode = localStorage.getItem(SORT_MODE_KEY) === 'opened' ? 'opened' : 'added';

function setSortMode(mode) {
  sortMode = mode === 'opened' ? 'opened' : 'added';
  localStorage.setItem(SORT_MODE_KEY, sortMode);
}

// View mode. 'list' is the table layout; 'gallery' is a cover grid where each
// card shows the first-page thumbnail with the title underneath. Persisted
// across new-tab opens.
const VIEW_MODE_KEY = 'paperclip-view-mode';
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === 'gallery' ? 'gallery' : 'list';

function setViewMode(mode) {
  viewMode = mode === 'gallery' ? 'gallery' : 'list';
  localStorage.setItem(VIEW_MODE_KEY, viewMode);
  const toggle = document.getElementById('viewToggle');
  if (!toggle) return;
  for (const btn of toggle.querySelectorAll('[data-view]')) {
    const active = btn.dataset.view === viewMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

// Keyboard cursor over the rendered results (command-palette style): ArrowDown
// from the search field enters the results, arrows move (grid-aware in
// gallery), each move previews in the side peek, ArrowUp from the top row
// returns to the input. The input keeps DOM focus throughout so typing
// continues to refine the query.
let renderedIds = [];
let cursorId = null;
let previewTimer = null;

function galleryCols() {
  if (viewMode !== 'gallery') return 1;
  const list = document.getElementById('paperList');
  if (!list) return 1;
  return Math.max(1, getComputedStyle(list).gridTemplateColumns.split(' ').length);
}

function applyCursor() {
  const list = document.getElementById('paperList');
  if (!list) return;
  for (const el of list.querySelectorAll('.is-cursor')) el.classList.remove('is-cursor');
  if (!cursorId) return;
  const el = list.querySelector(`.paper-row[data-id="${CSS.escape(cursorId)}"]`);
  if (el) {
    el.classList.add('is-cursor');
    el.scrollIntoView({ block: 'nearest' });
  }
}

function schedulePreview(id) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!window.PaperViewer || window.PaperViewer.isOpenFor(id)) return;
    const papers = await getPapers();
    const paper = papers[id];
    if (paper) window.PaperViewer.open(paper);
  }, 150);
}

function setCursorIndex(i) {
  if (!renderedIds.length) return;
  const idx = Math.max(0, Math.min(i, renderedIds.length - 1));
  cursorId = renderedIds[idx];
  applyCursor();
  schedulePreview(cursorId);
}

function clearCursor() {
  cursorId = null;
  applyCursor();
}

function sortPapers(list) {
  // Sort by the active mode's timestamp — newest first. Each mode falls back
  // to the other timestamp so entries missing a field don't sink to the bottom.
  const key = sortMode === 'opened'
    ? (p) => p.lastSeenAt || p.firstSeenAt || ''
    : (p) => p.firstSeenAt || p.lastSeenAt || '';
  return list.slice().sort((a, b) => key(b).localeCompare(key(a)));
}

// ─── Expanded-row state ──────────────────────────────────────────────────────

const expandedIds = new Set();
const selectedIds = new Set();
const recentlyCopiedIds = new Set();

function renderDetail(p) {
  const fullAuthors = (p.authors || []).filter(Boolean).join(', ');

  let abstractHtml;
  if (p.abstract) {
    abstractHtml = `<div class="paper-detail-text">${escapeHtml(p.abstract)}</div>`;
  } else if (p.enrichmentStatus === 'pending') {
    abstractHtml = '<div class="paper-detail-empty">Fetching abstract…</div>';
  } else if (p.enrichmentStatus === 'failed') {
    abstractHtml = '<div class="paper-detail-empty">Couldn\'t fetch abstract — will retry.</div>';
  } else {
    abstractHtml = '<div class="paper-detail-empty">No abstract available.</div>';
  }

  const attachments = Array.isArray(p.attachments) ? p.attachments.slice() : [];
  attachments.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

  const attachmentsHtml = attachments.length ? `
    <div class="paper-detail-row paper-detail-row-block">
      <span class="paper-detail-label">Linked URLs</span>
      <ul class="paper-attachment-list">
        ${attachments.map(a => `
          <li class="paper-attachment-item">
            <a class="paper-attachment-link"
               href="${escapeHtml(a.url)}"
               target="_blank"
               rel="noopener"
               title="${escapeHtml(a.url)}">${escapeHtml(a.title || a.url)}</a>
            ${a.autoAttached ? '<span class="paper-attachment-auto" title="Auto-detected from page contents">auto</span>' : ''}
            <button class="paper-attachment-remove"
                    data-action="remove-attachment"
                    data-paper-id="${escapeHtml(p.id)}"
                    data-attachment-url="${escapeHtml(a.url)}"
                    title="Remove this link"
                    aria-label="Remove this link">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 18 18 6M6 6l12 12"/>
              </svg>
            </button>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  return `
    <div class="paper-detail" data-detail-for="${escapeHtml(p.id)}">
      ${fullAuthors ? `
        <div class="paper-detail-row">
          <span class="paper-detail-label">Authors</span>
          <span class="paper-detail-value">${escapeHtml(fullAuthors)}</span>
        </div>` : ''}
      ${p.venue ? `
        <div class="paper-detail-row">
          <span class="paper-detail-label">Venue</span>
          <span class="paper-detail-value">${escapeHtml(p.venue)}</span>
        </div>` : ''}
      <div class="paper-detail-row paper-detail-row-block">
        <span class="paper-detail-label">Abstract</span>
        ${abstractHtml}
      </div>
      ${attachmentsHtml}
      <div class="paper-detail-row paper-detail-row-block">
        <a class="paper-detail-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.url)}</a>
      </div>
    </div>
  `;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const THUMB_PREFIX = 'thumb:';

function renderRow(p, openMap, thumb) {
  const open = openMap.get(p.id);
  const isOpen = !!open;

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

  const isExpanded = expandedIds.has(p.id);
  const isStarred = !!p.starred;
  const isSelected = selectedIds.has(p.id);
  const justCopied = recentlyCopiedIds.has(p.id);

  const classes = ['paper-row'];
  if (isOpen) classes.push('is-open');
  if (isExpanded) classes.push('is-expanded');
  if (isStarred) classes.push('is-starred');
  if (isSelected) classes.push('is-selected');
  if (justCopied) classes.push('is-just-copied');

  return `
    <div class="${classes.join(' ')}"
         draggable="true"
         data-id="${escapeHtml(p.id)}"
         data-url="${escapeHtml(p.url)}"
         ${open ? `data-tab-id="${open.id}" data-window-id="${open.windowId}"` : ''}>
      <button class="paper-select-checkbox"
              data-action="toggle-select"
              title="${isSelected ? 'Deselect' : 'Select'}"
              aria-label="${isSelected ? 'Deselect' : 'Select'}"
              aria-pressed="${isSelected}">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      </button>
      <div class="paper-thumb-cell">
        ${thumb
          ? `<img class="paper-thumb" src="${thumb}" alt="" loading="lazy">`
          : '<div class="paper-thumb paper-thumb-placeholder"></div>'}
      </div>
      <div class="paper-main">
        <div class="paper-title"><span class="paper-title-text">${escapeHtml(title)}</span></div>
        <div class="paper-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="paper-col-authors">${authorsStr ? escapeHtml(authorsStr) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-col-year">${p.year ? escapeHtml(String(p.year)) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-actions">
        <button class="paper-icon-btn paper-star-btn"
                data-action="toggle-star"
                title="${isStarred ? 'Unstar' : 'Star this paper'}"
                aria-label="${isStarred ? 'Unstar' : 'Star this paper'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        <button class="paper-icon-btn paper-expand-btn"
                data-action="toggle-expand"
                title="${isExpanded ? 'Hide details' : 'Show details'}"
                aria-label="${isExpanded ? 'Hide details' : 'Show details'}"
                aria-expanded="${isExpanded}">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${isExpanded ? 180 : 0}deg)">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        <button class="paper-icon-btn paper-copy-btn"
                data-action="copy-single"
                title="${justCopied ? 'Copied' : "Copy this paper's data"}"
                aria-label="${justCopied ? 'Copied' : "Copy this paper's data"}">
          ${justCopied
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M20 6 9 17l-5-5"/>
               </svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <rect x="9" y="9" width="13" height="13" rx="2"/>
                 <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
               </svg>`}
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
    ${isExpanded ? renderDetail(p) : ''}
  `;
}

// Gallery card: cover thumbnail with the title underneath. Reuses the
// .paper-row class so the delegated click handlers work unchanged (title
// click opens the paper, cover click opens the side peek).
function renderCard(p, openMap, thumb) {
  const open = openMap.get(p.id);
  const title = displayTitle(p);

  const classes = ['paper-row', 'paper-card'];
  if (open) classes.push('is-open');
  if (p.starred) classes.push('is-starred');
  if (selectedIds.has(p.id)) classes.push('is-selected');

  return `
    <div class="${classes.join(' ')}"
         draggable="true"
         data-id="${escapeHtml(p.id)}"
         data-url="${escapeHtml(p.url)}"
         ${open ? `data-tab-id="${open.id}" data-window-id="${open.windowId}"` : ''}>
      <div class="paper-card-cover">
        ${thumb
          ? `<img class="paper-card-thumb" src="${thumb}" alt="" loading="lazy">`
          : '<div class="paper-card-thumb-placeholder"></div>'}
        ${p.starred
          ? `<span class="paper-card-star">
               <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                 <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
               </svg>
             </span>`
          : ''}
      </div>
      <div class="paper-card-title paper-title-text" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
    </div>
  `;
}

async function renderSidebar() {
  const nav = document.getElementById('sidebarNav');
  if (!nav) return;
  const [papers, tags] = await Promise.all([getPapers(), getTags()]);
  const all = Object.values(papers);

  const total = all.length;
  const starredCount = all.filter(p => p.starred).length;
  const untaggedCount = all.filter(p => !Array.isArray(p.tags) || p.tags.length === 0).length;

  function builtin(kind, label, count) {
    const active = activeFilter.type === kind;
    return `
      <button class="sidebar-item${active ? ' is-active' : ''}"
              data-filter-kind="${kind}">
        <span class="sidebar-item-label">${escapeHtml(label)}</span>
        <span class="sidebar-item-count">${count}</span>
      </button>
    `;
  }

  const userTags = Object.values(tags).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );

  function renderUserTag(tag) {
    const count = countPapersWithTag(all, tag.id);
    const active = activeFilter.type === 'tag' && activeFilter.tagIds.has(tag.id);
    return `
      <div class="sidebar-item-wrap" data-tag-row-id="${escapeHtml(tag.id)}">
        <button class="sidebar-item${active ? ' is-active' : ''}"
                data-filter-kind="tag"
                data-tag-id="${escapeHtml(tag.id)}">
          <span class="sidebar-item-label">${escapeHtml(tag.name)}</span>
          <span class="sidebar-item-count">${count}</span>
        </button>
        <div class="sidebar-tag-actions">
          <button class="sidebar-tag-action"
                  data-tag-action="rename"
                  data-tag-id="${escapeHtml(tag.id)}"
                  title="Rename tag"
                  aria-label="Rename tag">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="sidebar-tag-action"
                  data-tag-action="delete"
                  data-tag-id="${escapeHtml(tag.id)}"
                  title="Delete tag"
                  aria-label="Delete tag">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  const tagsBlock = userTags.length === 0
    ? ''
    : `
      <div class="sidebar-divider"></div>
      <div class="sidebar-section-label">Tags</div>
      ${userTags.map(renderUserTag).join('')}
    `;

  nav.innerHTML = `
    <div class="sidebar-section-label">Library</div>
    ${builtin('all',      'All Papers', total)}
    ${builtin('starred',  'Starred',    starredCount)}
    ${builtin('untagged', 'Untagged',   untaggedCount)}
    ${tagsBlock}
    <div class="sidebar-divider"></div>
    <button class="sidebar-new-tag" id="sidebarNewTagBtn">
      <span class="sidebar-new-tag-icon">+</span>
      <span>New tag</span>
    </button>
    <input class="sidebar-new-tag-input" id="sidebarNewTagInput" type="text" placeholder="Tag name, then Enter" hidden>
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
  let filtered = q ? all.filter(p => paperMatchesFilter(p, q)) : all;
  filtered = filtered.filter(paperMatchesActiveTag);
  const sorted = sortPapers(filtered);

  renderedIds = sorted.map(p => p.id);
  if (cursorId && !renderedIds.includes(cursorId)) cursorId = null;

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
  const gallery = viewMode === 'gallery';
  list.classList.toggle('is-gallery', gallery);
  if (header) header.style.display = gallery ? 'none' : 'grid';
  const isFiltered = q || activeFilter.type !== 'all';
  countEl.textContent = isFiltered
    ? `${sorted.length} of ${all.length}`
    : `${all.length} paper${all.length === 1 ? '' : 's'}`;
  const thumbs = await chrome.storage.local.get(sorted.map(p => THUMB_PREFIX + p.id));
  const render = gallery ? renderCard : renderRow;
  list.innerHTML = sorted.map(p => render(p, openMap, thumbs[THUMB_PREFIX + p.id])).join('');
  applyCursor();

  // Drop selections that no longer exist (e.g. after delete)
  const valid = new Set(all.map(p => p.id));
  for (const id of [...selectedIds]) {
    if (!valid.has(id)) selectedIds.delete(id);
  }
  updateSelectionBar();
}

// ─── Multi-select action bar ──────────────────────────────────────────────────

function updateSelectionBar() {
  const bar = document.getElementById('selectionBar');
  const countEl = document.getElementById('selectionCount');
  if (!bar) return;
  if (selectedIds.size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  countEl.textContent = `${selectedIds.size} selected`;
}

function formatPaperForCopy(p) {
  const lines = [];
  lines.push(p.title || p.id);
  if (Array.isArray(p.authors) && p.authors.length) lines.push(p.authors.join(', '));
  const meta = [
    p.year ? String(p.year) : null,
    p.venue || null,
    SOURCE_LABELS[p.source] || p.source || null,
  ].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (p.url) lines.push(p.url);
  if (p.abstract) {
    lines.push('');
    lines.push(p.abstract);
  }
  if (Array.isArray(p.attachments) && p.attachments.length) {
    lines.push('');
    lines.push('Linked URLs:');
    for (const a of p.attachments) {
      if (!a || !a.url) continue;
      lines.push(`- ${a.title || a.url}\n  ${a.url}`);
    }
  }
  return lines.join('\n');
}

async function copySelectedToClipboard() {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const selected = [...selectedIds].map(id => papers[id]).filter(Boolean);
  if (!selected.length) return 0;
  // Sort selected the same way the list is sorted (consistent paste order)
  const sorted = sortPapers(selected);
  const text = sorted.map(formatPaperForCopy).join('\n\n---\n\n');
  await navigator.clipboard.writeText(text);
  return selected.length;
}

async function deleteSelected() {
  if (selectedIds.size === 0) return;
  const ok = confirm(`Delete ${selectedIds.size} paper${selectedIds.size === 1 ? '' : 's'}? Open tabs for them will also be closed.`);
  if (!ok) return;

  const ids = [...selectedIds];
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};

  // Build the set of canonical IDs (incl. aliases) whose tabs we should close.
  const canonicalsToClose = new Set();
  for (const id of ids) {
    const p = papers[id];
    if (!p) continue;
    canonicalsToClose.add(id);
    if (Array.isArray(p.aliases)) for (const a of p.aliases) canonicalsToClose.add(a);
  }

  try {
    const tabs = await chrome.tabs.query({});
    const tabIdsToClose = [];
    for (const t of tabs) {
      if (!t.url || t.id == null) continue;
      const cls = classifyPaper(t.url);
      if (cls && canonicalsToClose.has(cls.canonicalId)) tabIdsToClose.push(t.id);
    }
    if (tabIdsToClose.length) await chrome.tabs.remove(tabIdsToClose);
  } catch (err) {
    console.warn('[paperclip] could not close tabs for selected', err);
  }

  for (const id of ids) delete papers[id];
  await chrome.storage.local.set({ [PAPERS_KEY]: papers });

  selectedIds.clear();
}

function clearSelection() {
  if (selectedIds.size === 0) return;
  selectedIds.clear();
  const search = document.getElementById('paperSearch');
  renderLibrary(search ? search.value : '');
}

// Sidebar navigation is modal: picking a collection replaces the search filter
// rather than stacking on top of it.
function clearSearchInput() {
  const search = document.getElementById('paperSearch');
  if (search && search.value) search.value = '';
}

function initSelectionBar() {
  const bar = document.getElementById('selectionBar');
  if (!bar) return;
  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-selection-action]');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.selectionAction;

    if (action === 'copy') {
      await copySelectedToClipboard();
      clearSelection();
      return;
    }
    if (action === 'delete') {
      await deleteSelected();
      return;
    }
    if (action === 'clear') {
      clearSelection();
      return;
    }
  });
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// ─── Drag papers onto sidebar tags to tag them ────────────────────────────────

const DRAG_MIME = 'application/x-paperclip-ids';

function clearDropTargets() {
  for (const el of document.querySelectorAll('.sidebar-item.is-drop-target')) {
    el.classList.remove('is-drop-target');
  }
}

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('.paper-row');
  if (!row || !row.dataset.id) return;
  const ids = selectedIds.has(row.dataset.id) ? [...selectedIds] : [row.dataset.id];
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'link';
});

document.addEventListener('dragend', clearDropTargets);

function dropTargetFor(e) {
  if (![...e.dataTransfer.types].includes(DRAG_MIME)) return null;
  return e.target.closest &&
    e.target.closest('.sidebar-item[data-filter-kind="tag"], .sidebar-item[data-filter-kind="starred"]');
}

document.addEventListener('dragover', (e) => {
  const item = dropTargetFor(e);
  clearDropTargets();
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'link';
  item.classList.add('is-drop-target');
});

document.addEventListener('drop', async (e) => {
  const item = dropTargetFor(e);
  clearDropTargets();
  if (!item) return;
  e.preventDefault();
  let ids;
  try {
    ids = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
  } catch {
    return;
  }
  const kind = item.dataset.filterKind;
  const tagId = item.dataset.tagId;
  for (const id of ids) {
    await patchPaper(id, (paper) => {
      if (kind === 'starred') {
        paper.starred = true;
        return;
      }
      if (!Array.isArray(paper.tags)) paper.tags = [];
      if (!paper.tags.includes(tagId)) paper.tags.push(tagId);
    });
  }
});

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
  const paper = papers[id];
  if (!paper) return;

  // Close any currently-open tabs holding this paper (or any alias from
  // merged duplicates). Otherwise the next backfill scan will re-add it.
  const allIds = new Set([id, ...(Array.isArray(paper.aliases) ? paper.aliases : [])]);
  try {
    const tabs = await chrome.tabs.query({});
    const tabIdsToClose = [];
    for (const t of tabs) {
      if (!t.url || t.id == null) continue;
      const cls = classifyPaper(t.url);
      if (cls && allIds.has(cls.canonicalId)) tabIdsToClose.push(t.id);
    }
    if (tabIdsToClose.length) await chrome.tabs.remove(tabIdsToClose);
  } catch (err) {
    console.warn('[paperclip] could not close tabs for', id, err);
  }

  delete papers[id];
  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

document.addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    e.stopPropagation();
    e.preventDefault();

    // remove-attachment lives in .paper-detail (sibling of .paper-row) and
    // carries its own paperId on the button, so it doesn't need a row
    // ancestor — handle it before the row check below.
    if (action === 'remove-attachment') {
      const paperId = actionBtn.dataset.paperId;
      const attachUrl = actionBtn.dataset.attachmentUrl;
      if (paperId && attachUrl) {
        await patchPaper(paperId, paper => {
          paper.attachments = (paper.attachments || []).filter(a => a.url !== attachUrl);
        });
      }
      return;
    }

    const row = actionBtn.closest('.paper-row');
    if (!row) return;

    if (action === 'toggle-star') {
      // First click on an unstarred paper: just star it.
      // Click on an already-starred paper: open the tag picker so the user
      // can manage tag membership (and uncheck Starred to unstar).
      const id = row.dataset.id;
      const store = await chrome.storage.local.get(PAPERS_KEY);
      const papers = store[PAPERS_KEY] || {};
      const paper = papers[id];
      if (!paper) return;
      if (!paper.starred) {
        paper.starred = true;
        await chrome.storage.local.set({ [PAPERS_KEY]: papers });
      } else {
        await openTagPickerFor(actionBtn, id);
      }
      return;
    }
    if (action === 'copy-single') {
      const store = await chrome.storage.local.get(PAPERS_KEY);
      const papers = store[PAPERS_KEY] || {};
      const id = row.dataset.id;
      const paper = papers[id];
      if (!paper) return;
      try {
        await navigator.clipboard.writeText(formatPaperForCopy(paper));
      } catch (err) {
        console.warn('[paperclip] copy failed', err);
        return;
      }
      // Briefly swap the icon to a checkmark as confirmation, then revert.
      recentlyCopiedIds.add(id);
      const search = document.getElementById('paperSearch');
      renderLibrary(search ? search.value : '');
      setTimeout(() => {
        recentlyCopiedIds.delete(id);
        renderLibrary(search ? search.value : '');
      }, 2000);
      return;
    }
    if (action === 'toggle-select') {
      const id = row.dataset.id;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      const search = document.getElementById('paperSearch');
      renderLibrary(search ? search.value : '');
      return;
    }
    if (action === 'toggle-expand') {
      const id = row.dataset.id;
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      const search = document.getElementById('paperSearch');
      renderLibrary(search ? search.value : '');
      return;
    }
    if (action === 'delete') {
      await deletePaper(row.dataset.id);
      return;
    }
  }

  // Click on detail panel (abstract / link / etc.) — don't toggle, and keep
  // any active selection (user is still working with the library).
  if (e.target.closest('.paper-detail')) return;

  // Don't toggle when the user was selecting text.
  if (window.getSelection && window.getSelection().toString()) return;

  const row = e.target.closest('.paper-row');
  if (!row) {
    // Clicked outside any row. If selection is active and the click wasn't
    // on UI chrome that should preserve it (selection bar, settings menu),
    // drop the selection.
    if (
      selectedIds.size > 0 &&
      !e.target.closest('.selection-bar') &&
      !e.target.closest('.settings-menu') &&
      !e.target.closest('#settingsBtn')
    ) {
      clearSelection();
    }
    return;
  }
  const id = row.dataset.id;
  if (!id) return;

  // Cmd-click (Ctrl-click on non-Mac): toggle multi-selection, both views.
  if (e.metaKey || e.ctrlKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    const search = document.getElementById('paperSearch');
    renderLibrary(search ? search.value : '');
    return;
  }

  // Click on the title text: open the paper (jump to existing tab or open
  // a new one). Click anywhere else on the row: toggle expand.
  if (e.target.closest('.paper-title-text')) {
    const tabId = row.dataset.tabId ? parseInt(row.dataset.tabId, 10) : null;
    const windowId = row.dataset.windowId ? parseInt(row.dataset.windowId, 10) : null;
    if (tabId) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        if (windowId) await chrome.windows.update(windowId, { focused: true });
        return;
      } catch {}
    }
    if (row.dataset.url) chrome.tabs.create({ url: row.dataset.url });
    return;
  }

  // Click anywhere else on the row: open the PDF side peek (or close it if
  // it's already showing this paper).
  if (window.PaperViewer) {
    cursorId = id;
    applyCursor();
    if (window.PaperViewer.isOpenFor(id)) return;
    const papers = await getPapers();
    const paper = papers[id];
    if (paper) window.PaperViewer.open(paper);
  }
});

// Coalesce rapid re-render triggers (storage writes during enrichment, tab
// events firing for every URL/status/title change) into a single render so
// expanded rows don't visibly flash from constant DOM rebuilds.
let renderTimer = null;
function scheduleRender(delay = 200) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const search = document.getElementById('paperSearch');
    renderLibrary(search ? search.value : '');
    renderSidebar();
  }, delay);
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'paperSearch') {
    scheduleRender(80);
  }
});

// Re-render whenever the service worker writes new papers / enrichment,
// or the thumbnail renderer caches a new first-page image.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevant = changes[PAPERS_KEY]
    || Object.keys(changes).some(k => k.startsWith(THUMB_PREFIX));
  if (relevant) scheduleRender(150);
});

// Re-render on tab open/close so the open-status dots stay accurate.
if (chrome.tabs && chrome.tabs.onCreated && chrome.tabs.onRemoved) {
  const refresh = () => scheduleRender(250);
  chrome.tabs.onCreated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onUpdated.addListener((_, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) refresh();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// ─── Export / Import ──────────────────────────────────────────────────────────

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click finishes
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportLibrary() {
  const store = await chrome.storage.local.get([PAPERS_KEY, TAGS_KEY]);
  const papers = store[PAPERS_KEY] || {};
  const tags = store[TAGS_KEY] || {};
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadJson(`paperclip-backup-${stamp}.json`, {
    schema: 'paperclip.library.v2',
    exportedAt: new Date().toISOString(),
    paperCount: Object.keys(papers).length,
    tagCount: Object.keys(tags).length,
    papers,
    tags,
  });
  return { count: Object.keys(papers).length };
}

function isImportablePaper(p) {
  return p && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0;
}

function mergeImportedPaper(target, incoming) {
  if (!target.firstSeenAt || (incoming.firstSeenAt && incoming.firstSeenAt < target.firstSeenAt)) {
    target.firstSeenAt = incoming.firstSeenAt;
  }
  if (!target.lastSeenAt || (incoming.lastSeenAt && incoming.lastSeenAt > target.lastSeenAt)) {
    target.lastSeenAt = incoming.lastSeenAt;
  }
  target.visitCount = Math.max(target.visitCount || 0, incoming.visitCount || 0);

  if (!target.title && incoming.title) target.title = incoming.title;
  if (!target.year && incoming.year) target.year = incoming.year;
  if (!target.venue && incoming.venue) target.venue = incoming.venue;
  if (!target.abstract && incoming.abstract) target.abstract = incoming.abstract;
  if ((!target.authors || target.authors.length === 0) && Array.isArray(incoming.authors) && incoming.authors.length) {
    target.authors = incoming.authors;
  }
  if (!target.doi && incoming.doi) target.doi = incoming.doi;

  target.externalIds = { ...(incoming.externalIds || {}), ...(target.externalIds || {}) };

  const aliasSet = new Set([...(target.aliases || []), ...(incoming.aliases || [])]);
  target.aliases = [...aliasSet];

  // Merge attachments by URL (union, keep target's title/addedAt on conflict)
  const targetAtt = Array.isArray(target.attachments) ? target.attachments : [];
  const incomingAtt = Array.isArray(incoming.attachments) ? incoming.attachments : [];
  const seenUrls = new Set(targetAtt.map(a => a && a.url));
  for (const a of incomingAtt) {
    if (a && a.url && !seenUrls.has(a.url)) {
      targetAtt.push(a);
      seenUrls.add(a.url);
    }
  }
  target.attachments = targetAtt;

  if (incoming.readStatus === 'read') target.readStatus = 'read';
  if (incoming.starred) target.starred = true;

  // Tag membership: union by id (so an auto-tagged import adds tags to
  // existing papers without removing any the user manually added).
  const targetTags = Array.isArray(target.tags) ? target.tags : [];
  const incomingTags = Array.isArray(incoming.tags) ? incoming.tags : [];
  if (incomingTags.length) {
    const set = new Set(targetTags);
    for (const t of incomingTags) if (typeof t === 'string' && t) set.add(t);
    target.tags = [...set];
  } else if (!Array.isArray(target.tags)) {
    target.tags = targetTags;
  }
}

async function importLibrary(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Could not parse the file as JSON.' };
  }

  // Accept envelope shape { papers: {...}, tags?: {...} } or raw map of papers
  const hasEnvelope = parsed && typeof parsed === 'object' && parsed.papers && typeof parsed.papers === 'object';
  const incomingPapers = hasEnvelope ? parsed.papers : parsed;
  const incomingTags = hasEnvelope && parsed.tags && typeof parsed.tags === 'object' ? parsed.tags : {};

  if (!incomingPapers || typeof incomingPapers !== 'object') {
    return { error: 'Unexpected file shape — expected an object of papers.' };
  }

  const store = await chrome.storage.local.get([PAPERS_KEY, TAGS_KEY]);
  const papers = store[PAPERS_KEY] || {};
  const tags = store[TAGS_KEY] || {};

  // Merge tags map first so paper.tags references are valid afterwards.
  // Tag ids that already exist locally keep their existing name (no rename
  // surprises). New tag ids get added wholesale.
  let tagsAdded = 0;
  for (const [id, t] of Object.entries(incomingTags)) {
    if (!t || typeof t !== 'object' || typeof id !== 'string' || !id) continue;
    if (!tags[id]) {
      tags[id] = {
        id,
        name: typeof t.name === 'string' && t.name ? t.name : id,
        createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      };
      tagsAdded++;
    }
  }

  let added = 0, merged = 0, skipped = 0;
  for (const [id, item] of Object.entries(incomingPapers)) {
    if (!isImportablePaper(item)) { skipped++; continue; }
    if (item.id !== id) item.id = id;
    if (papers[id]) {
      mergeImportedPaper(papers[id], item);
      merged++;
    } else {
      papers[id] = item;
      added++;
    }
  }

  await chrome.storage.local.set({ [PAPERS_KEY]: papers, [TAGS_KEY]: tags });
  return { added, merged, skipped, tagsAdded };
}

// ─── Settings menu wiring ─────────────────────────────────────────────────────

function setSettingsStatus(text) {
  const el = document.getElementById('settingsStatus');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(setSettingsStatus._t);
  setSettingsStatus._t = setTimeout(() => { el.hidden = true; }, 4000);
}

async function refreshSettingsInfo() {
  const infoEl = document.getElementById('settingsInfo');
  if (!infoEl) return;
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const count = Object.keys(papers).length;
  const bytes = new Blob([JSON.stringify(papers)]).size;
  const sizeStr = bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(2) + ' MB'
    : (bytes / 1024).toFixed(1) + ' KB';
  infoEl.textContent = `${count} paper${count === 1 ? '' : 's'} · ${sizeStr} stored locally`;
}

function initSettingsMenu() {
  const btn = document.getElementById('settingsBtn');
  const menu = document.getElementById('settingsMenu');
  const fileInput = document.getElementById('importFile');
  if (!btn || !menu || !fileInput) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      menu.hidden = false;
      refreshSettingsInfo();
    } else {
      menu.hidden = true;
    }
  });

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (e.target.closest('#settingsMenu') || e.target.closest('#settingsBtn')) return;
    menu.hidden = true;
  });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-settings-action]');
    if (!item) return;
    e.stopPropagation();
    const action = item.dataset.settingsAction;
    if (action === 'export') {
      const { count } = await exportLibrary();
      setSettingsStatus(`Exported ${count} paper${count === 1 ? '' : 's'}.`);
    } else if (action === 'import') {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    menu.hidden = false;
    setSettingsStatus('Importing…');
    const result = await importLibrary(file);
    if (result.error) {
      setSettingsStatus(result.error);
    } else {
      const parts = [`${result.added} new`, `${result.merged} merged`];
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      setSettingsStatus('Imported: ' + parts.join(', '));
      refreshSettingsInfo();
    }
  });
}

// ─── Tag picker popover ──────────────────────────────────────────────────────

let tagPickerEl = null;
let tagPickerPaperId = null;
let tagPickerAnchor = null;

const PICKER_CHECKMARK = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function ensureTagPickerEl() {
  if (tagPickerEl) return tagPickerEl;
  const el = document.createElement('div');
  el.className = 'tag-picker';
  el.hidden = true;
  el.innerHTML = `
    <div class="tag-picker-header">Add to tags</div>
    <input class="tag-picker-input" type="text" placeholder="Find or create…" autocomplete="off">
    <div class="tag-picker-list"></div>
  `;
  document.body.appendChild(el);
  tagPickerEl = el;
  return el;
}

function positionTagPicker(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const elH = el.offsetHeight || 320;
  const margin = 6;
  let top = rect.bottom + margin + window.scrollY;
  if (rect.bottom + elH + margin + 12 > window.innerHeight) {
    top = rect.top - margin - elH + window.scrollY;
  }
  el.style.top = `${top}px`;
  el.style.right = `${Math.max(8, window.innerWidth - rect.right - window.scrollX)}px`;
  el.style.left = 'auto';
}

async function openTagPickerFor(anchorBtn, paperId) {
  const el = ensureTagPickerEl();
  tagPickerPaperId = paperId;
  tagPickerAnchor = anchorBtn;
  el.hidden = false;
  const input = el.querySelector('.tag-picker-input');
  input.value = '';
  await renderTagPickerList();
  positionTagPicker(el, anchorBtn);
  input.focus();
}

function closeTagPicker() {
  if (!tagPickerEl) return;
  tagPickerEl.hidden = true;
  tagPickerPaperId = null;
  tagPickerAnchor = null;
}

async function renderTagPickerList() {
  if (!tagPickerEl || tagPickerEl.hidden || !tagPickerPaperId) return;
  const listEl = tagPickerEl.querySelector('.tag-picker-list');
  const input = tagPickerEl.querySelector('.tag-picker-input');
  const filter = (input.value || '').trim().toLowerCase();

  const [papers, tags] = await Promise.all([getPapers(), getTags()]);
  const paper = papers[tagPickerPaperId];
  if (!paper) { closeTagPicker(); return; }

  const allTags = Object.values(tags).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );
  const matchedTags = filter
    ? allTags.filter(t => (t.name || '').toLowerCase().includes(filter))
    : allTags;

  const exactMatch = filter && allTags.some(t => (t.name || '').toLowerCase() === filter);

  const showStarred = !filter || 'starred'.includes(filter);
  const starredHtml = showStarred ? `
    <button class="tag-picker-item" data-picker-action="toggle-starred">
      <span class="tag-picker-check">${paper.starred ? PICKER_CHECKMARK : ''}</span>
      <span class="tag-picker-name">★ Starred</span>
    </button>
  ` : '';

  const tagRowsHtml = matchedTags.map(t => {
    const checked = Array.isArray(paper.tags) && paper.tags.includes(t.id);
    return `
      <button class="tag-picker-item"
              data-picker-action="toggle-tag"
              data-tag-id="${escapeHtml(t.id)}">
        <span class="tag-picker-check">${checked ? PICKER_CHECKMARK : ''}</span>
        <span class="tag-picker-name">${escapeHtml(t.name)}</span>
      </button>
    `;
  }).join('');

  const createHtml = filter && !exactMatch ? `
    <div class="tag-picker-divider"></div>
    <button class="tag-picker-item tag-picker-create" data-picker-action="create-tag">
      <span class="tag-picker-check">+</span>
      <span class="tag-picker-name">Create "${escapeHtml(input.value.trim())}"</span>
    </button>
  ` : '';

  listEl.innerHTML = starredHtml + tagRowsHtml + createHtml;
}

async function pickerToggleStarred() {
  if (!tagPickerPaperId) return;
  await patchPaper(tagPickerPaperId, p => { p.starred = !p.starred; });
  await renderTagPickerList();
}

async function pickerToggleTag(tagId) {
  if (!tagPickerPaperId || !tagId) return;
  await patchPaper(tagPickerPaperId, p => {
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    const idx = p.tags.indexOf(tagId);
    if (idx >= 0) p.tags.splice(idx, 1);
    else p.tags.push(tagId);
  });
  await renderTagPickerList();
}

async function pickerCreateAndAttach(name) {
  if (!tagPickerPaperId) return;
  const id = await createTag(name);
  if (!id) return;
  await patchPaper(tagPickerPaperId, p => {
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    if (!p.tags.includes(id)) p.tags.push(id);
  });
  const input = tagPickerEl.querySelector('.tag-picker-input');
  input.value = '';
  await renderTagPickerList();
  input.focus();
}

function initTagPicker() {
  // Picker actions
  document.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-picker-action]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const action = item.dataset.pickerAction;
    if (action === 'toggle-starred') {
      await pickerToggleStarred();
    } else if (action === 'toggle-tag') {
      await pickerToggleTag(item.dataset.tagId);
    } else if (action === 'create-tag') {
      const input = tagPickerEl.querySelector('.tag-picker-input');
      const name = (input.value || '').trim();
      if (name) await pickerCreateAndAttach(name);
    }
  });

  // Re-render on input typing
  document.addEventListener('input', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('tag-picker-input')) {
      renderTagPickerList();
    }
  });

  // Enter / Escape inside the picker input
  document.addEventListener('keydown', async (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('tag-picker-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = (e.target.value || '').trim();
        if (!name) return;
        const tags = await getTags();
        const matched = Object.values(tags).find(
          t => (t.name || '').toLowerCase() === name.toLowerCase()
        );
        if (matched) {
          await pickerToggleTag(matched.id);
          e.target.value = '';
          await renderTagPickerList();
        } else {
          await pickerCreateAndAttach(name);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeTagPicker();
      }
      return;
    }
    if (e.key === 'Escape' && tagPickerEl && !tagPickerEl.hidden) {
      closeTagPicker();
    }
  });

  // Click outside → close
  document.addEventListener('click', (e) => {
    if (!tagPickerEl || tagPickerEl.hidden) return;
    if (e.target.closest('.tag-picker')) return;
    if (e.target.closest('.paper-star-btn')) return;
    closeTagPicker();
  });

  // Close on viewport resize (positioning would be stale)
  window.addEventListener('resize', () => {
    if (tagPickerEl && !tagPickerEl.hidden) closeTagPicker();
  });
  window.addEventListener('scroll', () => {
    if (tagPickerEl && !tagPickerEl.hidden && tagPickerAnchor) {
      positionTagPicker(tagPickerEl, tagPickerAnchor);
    }
  }, { passive: true });
}

// ─── Sidebar wiring ───────────────────────────────────────────────────────────

function initSidebar() {
  const nav = document.getElementById('sidebarNav');
  if (!nav) return;

  function refresh() {
    renderSidebar();
    const search = document.getElementById('paperSearch');
    renderLibrary(search ? search.value : '');
  }

  nav.addEventListener('click', async (e) => {
    // 1. Tag actions (rename / delete) — handle first since they share the
    // same DOM tree as the filter button.
    const actionBtn = e.target.closest('[data-tag-action]');
    if (actionBtn) {
      e.stopPropagation();
      e.preventDefault();
      const tagId = actionBtn.dataset.tagId;
      const tags = await getTags();
      const tag = tags[tagId];
      if (!tag) return;

      if (actionBtn.dataset.tagAction === 'rename') {
        const next = window.prompt('Rename tag', tag.name);
        if (next == null) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === tag.name) return;
        await renameTagById(tagId, trimmed);
        refresh();
        return;
      }
      if (actionBtn.dataset.tagAction === 'delete') {
        const papers = await getPapers();
        const n = countPapersWithTag(Object.values(papers), tagId);
        const msg = n === 0
          ? `Delete tag "${tag.name}"?`
          : `Delete tag "${tag.name}"? It's on ${n} paper${n === 1 ? '' : 's'} (the papers themselves stay).`;
        if (!window.confirm(msg)) return;
        // If the active filter included this tag, drop it.
        if (activeFilter.tagIds.has(tagId)) {
          activeFilter.tagIds.delete(tagId);
          if (activeFilter.tagIds.size === 0) activeFilter.type = 'all';
        }
        await deleteTagById(tagId);
        refresh();
        return;
      }
    }

    // 2. New-tag button — swap to inline input
    const newBtn = e.target.closest('#sidebarNewTagBtn');
    if (newBtn) {
      const input = document.getElementById('sidebarNewTagInput');
      newBtn.hidden = true;
      input.hidden = false;
      input.value = '';
      input.focus();
      return;
    }

    // 3. Filter buttons (all / starred / untagged / tag)
    const btn = e.target.closest('[data-filter-kind]');
    if (!btn) return;
    clearSearchInput();
    const kind = btn.dataset.filterKind;
    if (kind === 'all' || kind === 'starred' || kind === 'untagged') {
      activeFilter.type = kind;
      activeFilter.tagIds.clear();
      refresh();
      return;
    }
    if (kind === 'tag') {
      const tagId = btn.dataset.tagId;
      if (!tagId) return;
      const meta = e.metaKey || e.ctrlKey;

      if (meta) {
        // Cmd/Ctrl-click: toggle this tag's membership in the active set
        // (OR filter — show papers matching ANY selected tag).
        if (activeFilter.type !== 'tag') {
          activeFilter.type = 'tag';
          activeFilter.tagIds = new Set();
        }
        if (activeFilter.tagIds.has(tagId)) {
          activeFilter.tagIds.delete(tagId);
          if (activeFilter.tagIds.size === 0) activeFilter.type = 'all';
        } else {
          activeFilter.tagIds.add(tagId);
        }
      } else {
        // Plain click: replace with single-tag, or clear if same single tag
        const alreadyOnlyThisTag =
          activeFilter.type === 'tag' &&
          activeFilter.tagIds.size === 1 &&
          activeFilter.tagIds.has(tagId);
        if (alreadyOnlyThisTag) {
          activeFilter.type = 'all';
          activeFilter.tagIds.clear();
        } else {
          activeFilter.type = 'tag';
          activeFilter.tagIds.clear();
          activeFilter.tagIds.add(tagId);
        }
      }
      refresh();
    }
  });

  nav.addEventListener('keydown', async (e) => {
    if (e.target && e.target.id === 'sidebarNewTagInput') {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = e.target.value.trim();
        e.target.hidden = true;
        const btn = document.getElementById('sidebarNewTagBtn');
        if (btn) btn.hidden = false;
        if (name) {
          await createTag(name);
          refresh();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.target.hidden = true;
        const btn = document.getElementById('sidebarNewTagBtn');
        if (btn) btn.hidden = false;
      }
    }
  });

  // Cancel new-tag input when it loses focus without an Enter
  nav.addEventListener('focusout', (e) => {
    if (e.target && e.target.id === 'sidebarNewTagInput') {
      // Defer to allow click events on other items to commit first
      setTimeout(() => {
        const input = document.getElementById('sidebarNewTagInput');
        const btn = document.getElementById('sidebarNewTagBtn');
        if (input && !input.hidden) {
          input.hidden = true;
          if (btn) btn.hidden = false;
        }
      }, 100);
    }
  });
}

function init() {
  const greeting = document.getElementById('greeting');
  const date = document.getElementById('dateDisplay');
  if (greeting) greeting.textContent = getGreeting();
  if (date) date.textContent = getDateDisplay();
  const sortSelect = document.getElementById('paperSort');
  if (sortSelect) {
    sortSelect.value = sortMode;
    sortSelect.addEventListener('change', () => {
      setSortMode(sortSelect.value);
      const search = document.getElementById('paperSearch');
      renderLibrary(search ? search.value : '');
    });
  }

  const viewToggle = document.getElementById('viewToggle');
  if (viewToggle) {
    setViewMode(viewMode);
    viewToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn || btn.dataset.view === viewMode) return;
      setViewMode(btn.dataset.view);
      const search = document.getElementById('paperSearch');
      renderLibrary(search ? search.value : '');
    });
  }

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const searchKbd = document.getElementById('searchKbd');
  if (searchKbd && !isMac) searchKbd.textContent = 'Ctrl K';
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'k' || !(isMac ? e.metaKey : e.ctrlKey)) return;
    if (e.altKey || e.shiftKey) return;
    const search = document.getElementById('paperSearch');
    if (!search) return;
    e.preventDefault();
    search.focus();
    search.select();
  });

  const searchInput = document.getElementById('paperSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => { cursorId = null; });
  }

  // Zone model: clicking the right panel focuses the (scrollable) PDF body,
  // so arrow keys natively scroll the paper; clicking anywhere on the left
  // drops focus back to the page, so arrows navigate the library again.
  const pdfPanel = document.getElementById('pdfPanel');
  const pdfPanelBody = document.getElementById('pdfPanelBody');
  if (pdfPanel && pdfPanelBody) {
    pdfPanel.addEventListener('pointerdown', () => {
      const lectorRoot = document.getElementById('lectorRoot');
      (lectorRoot || pdfPanelBody).focus({ preventScroll: true });
    });
  }

  // Results navigation. Active from the search field always, and from page
  // scope once a paper is anchored (by arrows or by clicking a card) — so a
  // manual click hands off to the keyboard seamlessly. Other inputs and the
  // PDF panel keep their own key handling.
  document.addEventListener('keydown', (e) => {
    if (!renderedIds.length) return;
    const t = e.target;
    const inSearch = t === searchInput;
    if (!inSearch) {
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], #pdfPanel')) return;
      if (!cursorId) return;
    }
    const idx = cursorId ? renderedIds.indexOf(cursorId) : -1;
    const cols = galleryCols();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursorIndex(idx < 0 ? 0 : idx + cols);
    } else if (e.key === 'ArrowUp') {
      if (idx < 0) return;
      e.preventDefault();
      if (idx - cols < 0) {
        clearCursor();
        if (searchInput) searchInput.focus();
      } else {
        setCursorIndex(idx - cols);
      }
    } else if (e.key === 'ArrowRight' && idx >= 0 && viewMode === 'gallery') {
      e.preventDefault();
      setCursorIndex(idx + 1);
    } else if (e.key === 'ArrowLeft' && idx >= 0 && viewMode === 'gallery') {
      e.preventDefault();
      setCursorIndex(idx - 1);
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault();
      const title = document.querySelector(
        `#paperList .paper-row[data-id="${CSS.escape(cursorId)}"] .paper-title-text`
      );
      if (title) title.click();
    } else if (e.key === 'Escape' && idx >= 0) {
      e.preventDefault();
      clearCursor();
    }
  });

  renderLibrary();
  renderSidebar();
  initSidebar();
  initSettingsMenu();
  initSelectionBar();
  initTagPicker();

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
