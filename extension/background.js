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
  if (paper.enrichmentStatus === 'ok' || paper.enrichmentStatus === 'unsupported') return;

  let patches = null;
  try {
    patches = await PaperEnrich.enrich(paper);
  } catch (err) {
    console.warn('[paperclip] enrich error', canonicalId, err);
    paper.enrichmentStatus = 'failed';
    paper.enrichedAt = new Date().toISOString();
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches == null) {
    paper.enrichmentStatus = 'unsupported';
    paper.enrichedAt = new Date().toISOString();
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches.title) paper.title = patches.title;
  if (Array.isArray(patches.authors) && patches.authors.length) paper.authors = patches.authors;
  if (patches.year != null) paper.year = patches.year;
  if (patches.venue) paper.venue = patches.venue;
  if (patches.abstract) paper.abstract = patches.abstract;
  paper.enrichmentStatus = 'ok';
  paper.enrichedAt = new Date().toISOString();

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

/**
 * Find any papers that are stuck in 'pending' or 'failed' state and re-queue
 * them. Called after backfill, on browser startup, and on extension install
 * so transient errors (rate limits, dropped connections, worker death) get
 * picked up the next time the user does anything.
 */
async function retryStuckEnrichments() {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  for (const p of Object.values(papers)) {
    if (p.enrichmentStatus === 'pending' || p.enrichmentStatus === 'failed') {
      scheduleEnrichment(p.id);
    }
  }
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
