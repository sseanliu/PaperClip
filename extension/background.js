/**
 * background.js — Service Worker
 *
 * Two responsibilities:
 *   1. Toolbar badge: shows count of open real-web tabs, color-coded by load.
 *   2. Paper auto-capture: any paper URL visited gets persisted to
 *      chrome.storage.local.papers permanently, with metadata enrichment
 *      kicked off in the background.
 */

// Pull in the URL classifier and metadata fetcher.
importScripts('papers.js', 'enrich.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count === 0) return;

    let color;
    if (count <= 10) color = '#3d7a4a';
    else if (count <= 20) color = '#b8892e';
    else color = '#b35a5a';
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Paper auto-capture ───────────────────────────────────────────────────────

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
  acl: 'ACL',
  semanticscholar: 'Semantic Scholar',
  pdf: 'PDF',
};

/**
 * Heuristic: does this string look like a URL or filename, not a real paper
 * title? Chrome's PDF viewer often sets tab.title to the URL with no scheme
 * (e.g. "arxiv.org/pdf/2604.22615"), and we don't want that as a "title".
 */
function looksLikeUrlOrFilename(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  // host/path with no spaces (real titles always have spaces)
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(t) && !/\s/.test(t)) return true;
  // bare PDF filename
  if (/^[\w.-]+\.pdf$/i.test(t)) return true;
  return false;
}

/**
 * Fallback title cleanup for when enrichment hasn't run yet. Trims trailing
 * site-name garbage like " - arXiv" or " | OpenReview", and rejects titles
 * that are just the URL.
 */
function fallbackTitle(rawTitle, cls) {
  const cleaned = (rawTitle || '')
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && !looksLikeUrlOrFilename(cleaned)) return cleaned;
  // Build a friendly placeholder from the classification, if available
  if (cls && cls.sourceId) {
    const label = SOURCE_LABELS[cls.source] || cls.source;
    return `${label}:${cls.sourceId}`;
  }
  return '';
}

// Per-tab dedup: tabId → canonicalId of the last paper we logged on that tab.
// Used so onUpdated firing multiple times during one navigation only counts
// a single visit.
const lastCapturedByTab = new Map();

/**
 * Upsert a paper into storage.
 *
 * mode:
 *   'visit'    — real navigation. Bump visitCount + lastSeenAt if the tab's
 *                paper changed; otherwise just refresh title if missing.
 *   'discover' — found via tab scan / backfill. Add only if absent.
 *                Doesn't bump visitCount or lastSeenAt for existing entries.
 */
async function capturePaper(tab, mode = 'visit') {
  if (!tab || !tab.url) return;
  const cls = classifyPaper(tab.url);
  if (!cls) {
    if (tab.id != null) lastCapturedByTab.delete(tab.id);
    return;
  }

  const now = new Date().toISOString();
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const existing = papers[cls.canonicalId];

  let didMutate = false;

  if (existing) {
    if (mode === 'visit') {
      const tabPrev = tab.id != null ? lastCapturedByTab.get(tab.id) : null;
      const isFreshVisit = tabPrev !== cls.canonicalId;
      if (isFreshVisit) {
        existing.lastSeenAt = now;
        existing.visitCount = (existing.visitCount || 0) + 1;
        didMutate = true;
      }
      if (tab.url && existing.url !== tab.url) {
        existing.url = tab.url;
        didMutate = true;
      }
      const t = fallbackTitle(tab.title || '', cls);
      if (!existing.title && t) {
        existing.title = t;
        didMutate = true;
      }
    }
    // mode === 'discover' on an existing entry: nothing to do.
  } else {
    papers[cls.canonicalId] = {
      id: cls.canonicalId,
      url: tab.url,
      source: cls.source,
      sourceId: cls.sourceId,
      doi: cls.doi || null,
      title: fallbackTitle(tab.title || '', cls),
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1,
      readStatus: 'unread',
      enrichmentStatus: 'pending',
      enrichedAt: null
    };
    didMutate = true;
  }

  if (tab.id != null) lastCapturedByTab.set(tab.id, cls.canonicalId);
  if (!didMutate) return;

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });

  // Kick off metadata enrichment for new entries (or retry if previously failed).
  const paper = papers[cls.canonicalId];
  if (paper.enrichmentStatus !== 'ok' && paper.enrichmentStatus !== 'unsupported') {
    scheduleEnrichment(cls.canonicalId);
  }
}

/**
 * Scan every currently-open tab and add any papers we don't already have.
 * Used on extension install, browser startup, and on every new-tab page load.
 */
async function backfillExistingTabs() {
  let added = 0;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url) continue;
      const cls = classifyPaper(t.url);
      if (!cls) continue;
      const before = (await chrome.storage.local.get(PAPERS_KEY))[PAPERS_KEY] || {};
      if (before[cls.canonicalId]) continue;
      await capturePaper(t, 'discover');
      added += 1;
    }
  } catch (err) {
    console.warn('[paperclip] backfill error', err);
  }
  return added;
}

// ─── Metadata enrichment queue ────────────────────────────────────────────────
//
// All enrichment runs serially through a single Promise chain with a small
// throttle delay between requests. arXiv and Semantic Scholar both rate-limit
// hard — firing 30+ concurrent requests gets most of them rejected. One per
// second is well within everyone's budget.

const ENRICH_THROTTLE_MS = 900;

// Bumped whenever the enrichment schema or behavior changes meaningfully.
// retryStuckEnrichments() re-runs anything below the current version.
const ENRICHMENT_VERSION = 2;

const enrichQueued = new Set();
let enrichChain = Promise.resolve();

function scheduleEnrichment(canonicalId) {
  if (enrichQueued.has(canonicalId)) return;
  enrichQueued.add(canonicalId);
  enrichChain = enrichChain.then(async () => {
    try {
      await runEnrichmentOnce(canonicalId);
    } catch (err) {
      console.warn('[paperclip] enrich queue error', canonicalId, err);
    } finally {
      enrichQueued.delete(canonicalId);
    }
    await new Promise(r => setTimeout(r, ENRICH_THROTTLE_MS));
  });
}

async function runEnrichmentOnce(canonicalId) {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const paper = papers[canonicalId];
  if (!paper) return;

  const isCurrent = (paper.enrichmentVersion || 0) >= ENRICHMENT_VERSION;
  if ((paper.enrichmentStatus === 'ok' || paper.enrichmentStatus === 'unsupported') && isCurrent) {
    return;
  }

  let patches = null;
  try {
    patches = await PaperEnrich.enrich(paper);
  } catch (err) {
    console.warn('[paperclip] enrich error', canonicalId, err);
    paper.enrichmentStatus = 'failed';
    paper.enrichedAt = new Date().toISOString();
    paper.enrichmentVersion = ENRICHMENT_VERSION;
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches == null) {
    paper.enrichmentStatus = 'unsupported';
    paper.enrichedAt = new Date().toISOString();
    paper.enrichmentVersion = ENRICHMENT_VERSION;
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches.title) paper.title = patches.title;
  if (Array.isArray(patches.authors) && patches.authors.length) paper.authors = patches.authors;
  if (patches.year != null) paper.year = patches.year;
  if (patches.venue) paper.venue = patches.venue;
  if (patches.abstract) paper.abstract = patches.abstract;
  if (patches.externalIds) paper.externalIds = patches.externalIds;
  paper.enrichmentStatus = 'ok';
  paper.enrichedAt = new Date().toISOString();
  paper.enrichmentVersion = ENRICHMENT_VERSION;

  // Now that we know this paper's external IDs (DOI / ArXiv / etc.), check
  // whether any other entry in the library is the same paper under a
  // different canonical ID — same paper visited via arxiv URL and via the
  // CHI portal, for example. If so, merge them.
  dedupeAcrossExternalIds(papers, canonicalId);

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

/**
 * Find any papers that need enrichment and re-queue them. Includes:
 *   - 'pending' or 'failed' status (never finished or transient error)
 *   - 'ok' but enrichmentVersion is below the current code (schema upgrade)
 * Called after backfill, on browser startup, and on extension install.
 */
async function retryStuckEnrichments() {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  for (const p of Object.values(papers)) {
    const isCurrent = (p.enrichmentVersion || 0) >= ENRICHMENT_VERSION;
    if (
      p.enrichmentStatus === 'pending' ||
      p.enrichmentStatus === 'failed' ||
      !isCurrent
    ) {
      scheduleEnrichment(p.id);
    }
  }
}

// ─── Cross-source duplicate detection ─────────────────────────────────────────
//
// Same paper opened from multiple sources (arxiv pre-print + ACM camera-ready)
// gets stored under different canonical IDs. After enrichment fills in the
// externalIds field via Semantic Scholar, we can detect these duplicates by
// matching shared DOIs / arXiv IDs and merge them.

function externalIdSet(paper) {
  const ids = new Set();
  if (typeof paper.id === 'string') {
    if (paper.id.startsWith('arxiv:')) {
      ids.add(`arxiv:${paper.id.slice(6).toLowerCase().replace(/v\d+$/, '')}`);
    } else if (paper.id.startsWith('doi:')) {
      ids.add(`doi:${paper.id.slice(4).toLowerCase()}`);
    }
  }
  if (paper.doi) ids.add(`doi:${String(paper.doi).toLowerCase()}`);
  const ext = paper.externalIds || {};
  if (ext.DOI) ids.add(`doi:${String(ext.DOI).toLowerCase()}`);
  if (ext.ArXiv) ids.add(`arxiv:${String(ext.ArXiv).toLowerCase().replace(/v\d+$/, '')}`);
  return ids;
}

function papersAreDuplicates(a, b) {
  if (a.id === b.id) return false;
  const aIds = externalIdSet(a);
  if (aIds.size === 0) return false;
  for (const id of externalIdSet(b)) {
    if (aIds.has(id)) return true;
  }
  return false;
}

function mergePapers(primary, secondary) {
  if (!primary.firstSeenAt || (secondary.firstSeenAt && secondary.firstSeenAt < primary.firstSeenAt)) {
    primary.firstSeenAt = secondary.firstSeenAt;
  }
  if (!primary.lastSeenAt || (secondary.lastSeenAt && secondary.lastSeenAt > primary.lastSeenAt)) {
    primary.lastSeenAt = secondary.lastSeenAt;
  }
  primary.visitCount = (primary.visitCount || 0) + (secondary.visitCount || 0);

  if (!primary.title && secondary.title) primary.title = secondary.title;
  if (!primary.year && secondary.year) primary.year = secondary.year;
  if (!primary.venue && secondary.venue) primary.venue = secondary.venue;
  if (!primary.abstract && secondary.abstract) primary.abstract = secondary.abstract;
  if ((!primary.authors || primary.authors.length === 0) && Array.isArray(secondary.authors) && secondary.authors.length) {
    primary.authors = secondary.authors;
  }
  if (!primary.doi && secondary.doi) primary.doi = secondary.doi;

  // externalIds union, primary wins on conflicts
  primary.externalIds = { ...(secondary.externalIds || {}), ...(primary.externalIds || {}) };

  // Track aliases so we know which canonical IDs got folded in here.
  const aliases = new Set(primary.aliases || []);
  aliases.add(secondary.id);
  if (Array.isArray(secondary.aliases)) {
    for (const a of secondary.aliases) aliases.add(a);
  }
  primary.aliases = [...aliases];

  if (secondary.readStatus === 'read') primary.readStatus = 'read';
}

function dedupeAcrossExternalIds(papers, paperId) {
  const target = papers[paperId];
  if (!target) return false;

  const matches = [];
  for (const p of Object.values(papers)) {
    if (p.id === paperId) continue;
    if (papersAreDuplicates(target, p)) matches.push(p);
  }
  if (matches.length === 0) return false;

  // Pick primary as the entry with the earliest firstSeenAt — keeps the
  // user's library order stable.
  const all = [target, ...matches];
  all.sort((a, b) => (a.firstSeenAt || '').localeCompare(b.firstSeenAt || ''));
  const primary = all[0];

  for (const s of all.slice(1)) {
    mergePapers(primary, s);
    delete papers[s.id];
  }
  return true;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  retryStuckEnrichments();
});

chrome.runtime.onStartup.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  retryStuckEnrichments();
});

chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  if (tab && tab.url) capturePaper(tab, 'visit');
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateBadge();
  lastCapturedByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();
  // Capture on URL change (eager — don't wait for load to finish), on load
  // complete (so we get the final title), and on title-only updates (Chrome
  // sometimes sets the title after status='complete'). capturePaper dedupes
  // per-tab so we don't overcount visits when multiple events fire.
  if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
    if (tab && tab.url) capturePaper(tab, 'visit');
  }
});

// Message handler: the new-tab page asks us to re-scan tabs whenever it
// loads, as a safety net for anything we missed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'paperclip:backfill') {
    (async () => {
      const count = await backfillExistingTabs();
      retryStuckEnrichments();
      sendResponse({ ok: true, count });
    })();
    return true; // keep channel open for async response
  }
});

// Initial run
updateBadge();
backfillExistingTabs().then(() => retryStuckEnrichments());
