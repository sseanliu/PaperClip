/**
 * background.js — Service Worker
 *
 * Two responsibilities:
 *   1. Toolbar badge: shows count of open real-web tabs, color-coded by load.
 *   2. Paper auto-capture: any paper URL visited gets persisted to
 *      chrome.storage.local.papers permanently, with metadata enrichment
 *      kicked off in the background.
 */

// Pull in the URL classifier (same module the new-tab page uses).
importScripts('papers.js');

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

/**
 * Upsert a paper into storage. Idempotent: re-visiting the same paper just
 * bumps lastSeenAt + visitCount.
 */
async function capturePaper(tab) {
  if (!tab || !tab.url) return;
  const cls = classifyPaper(tab.url);
  if (!cls) return;

  const now = new Date().toISOString();
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const existing = papers[cls.canonicalId];

  if (existing) {
    existing.lastSeenAt = now;
    existing.visitCount = (existing.visitCount || 0) + 1;
    existing.url = tab.url;
    if (!existing.title && tab.title) existing.title = fallbackTitle(tab.title);
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
  }

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());

chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  // Most tabs are created with about:blank and only get a real URL via
  // onUpdated, so capture is mostly handled there. But cover the case where
  // a tab is opened directly to a paper URL.
  if (tab && tab.url) capturePaper(tab);
});

chrome.tabs.onRemoved.addListener(() => updateBadge());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();
  // Only act on the final URL once the page has finished loading.
  if (changeInfo.status === 'complete' && tab && tab.url) {
    capturePaper(tab);
  }
});

// Initial run
updateBadge();
