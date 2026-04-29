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

// ─── Expanded-row state ──────────────────────────────────────────────────────

const expandedIds = new Set();

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

function renderRow(p, openMap) {
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

  const classes = ['paper-row'];
  if (isOpen) classes.push('is-open');
  if (isExpanded) classes.push('is-expanded');

  return `
    <div class="${classes.join(' ')}"
         data-id="${escapeHtml(p.id)}"
         data-url="${escapeHtml(p.url)}"
         ${open ? `data-tab-id="${open.id}" data-window-id="${open.windowId}"` : ''}>
      <div class="paper-main">
        <div class="paper-title"><span class="paper-title-text">${escapeHtml(title)}</span></div>
        <div class="paper-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="paper-col-authors">${authorsStr ? escapeHtml(authorsStr) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-col-year">${p.year ? escapeHtml(String(p.year)) : '<span class="paper-empty-cell">—</span>'}</div>
      <div class="paper-actions">
        <button class="paper-icon-btn paper-open-btn"
                data-action="open-paper"
                title="${isOpen ? 'Jump to tab' : 'Open paper'}"
                aria-label="${isOpen ? 'Jump to tab' : 'Open paper'}">
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
    ${isExpanded ? renderDetail(p) : ''}
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
    const row = actionBtn.closest('.paper-row');
    if (!row) return;
    e.stopPropagation();
    e.preventDefault();

    if (action === 'open-paper') {
      // Jump to existing tab if open, otherwise open in a new tab.
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
    if (action === 'delete') {
      await deletePaper(row.dataset.id);
      return;
    }
    if (action === 'remove-attachment') {
      const paperId = actionBtn.dataset.paperId;
      const attachUrl = actionBtn.dataset.attachmentUrl;
      if (!paperId || !attachUrl) return;
      await patchPaper(paperId, paper => {
        paper.attachments = (paper.attachments || []).filter(a => a.url !== attachUrl);
      });
      return;
    }
  }

  // Click on detail panel (abstract / link / etc.) — don't toggle.
  if (e.target.closest('.paper-detail')) return;

  // Don't toggle when the user was selecting text.
  if (window.getSelection && window.getSelection().toString()) return;

  const row = e.target.closest('.paper-row');
  if (!row) return;
  const id = row.dataset.id;
  if (!id) return;

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

  if (expandedIds.has(id)) {
    expandedIds.delete(id);
  } else {
    expandedIds.add(id);
  }

  const search = document.getElementById('paperSearch');
  renderLibrary(search ? search.value : '');
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
  }, delay);
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'paperSearch') {
    scheduleRender(80);
  }
});

// Re-render whenever the service worker writes new papers / enrichment.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PAPERS_KEY]) return;
  scheduleRender(150);
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
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadJson(`paperclip-backup-${stamp}.json`, {
    schema: 'paperclip.library.v1',
    exportedAt: new Date().toISOString(),
    paperCount: Object.keys(papers).length,
    papers,
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
}

async function importLibrary(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Could not parse the file as JSON.' };
  }
  // Accept envelope shape { papers: {...} } or raw map { id: paper, ... }
  const incoming = (parsed && typeof parsed === 'object' && parsed.papers && typeof parsed.papers === 'object')
    ? parsed.papers
    : parsed;
  if (!incoming || typeof incoming !== 'object') {
    return { error: 'Unexpected file shape — expected an object of papers.' };
  }

  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};

  let added = 0, merged = 0, skipped = 0;
  for (const [id, item] of Object.entries(incoming)) {
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

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
  return { added, merged, skipped };
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

function init() {
  const greeting = document.getElementById('greeting');
  const date = document.getElementById('dateDisplay');
  if (greeting) greeting.textContent = getGreeting();
  if (date) date.textContent = getDateDisplay();
  renderLibrary();
  initSettingsMenu();

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
