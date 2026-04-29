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

/**
 * Fallback title cleanup for when enrichment hasn't run yet. Trims trailing
 * site-name garbage like " - arXiv" or " | OpenReview".
 */
function fallbackTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
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
      const t = fallbackTitle(tab.title || '');
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
      title: fallbackTitle(tab.title || ''),
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
    enrichInBackground(cls.canonicalId);
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

const enrichInFlight = new Set();

async function enrichInBackground(canonicalId) {
  if (enrichInFlight.has(canonicalId)) return;
  enrichInFlight.add(canonicalId);
  try {
    const store = await chrome.storage.local.get(PAPERS_KEY);
    const papers = store[PAPERS_KEY] || {};
    const paper = papers[canonicalId];
    if (!paper) return;

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
  } finally {
    enrichInFlight.delete(canonicalId);
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  backfillExistingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  backfillExistingTabs();
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
    backfillExistingTabs().then(count => sendResponse({ ok: true, count }));
    return true; // keep channel open for async response
  }
});

// Initial run
updateBadge();
backfillExistingTabs();
