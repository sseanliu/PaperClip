/**
 * thumbs.js — render first-page thumbnails for library entries.
 *
 * Runs in the new-tab page as an ES module. For each paper that has a
 * reachable PDF URL and no cached thumbnail, fetches the PDF (PDF.js uses
 * range requests, so only the bytes needed for page 1 are downloaded when
 * the server supports them), renders page 1 to a small canvas, and caches
 * the JPEG data URL in chrome.storage.local under `thumb:<paperId>`.
 *
 * app.js reads those keys when rendering rows; its storage.onChanged
 * listener re-renders as thumbnails land.
 */

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const PAPERS_KEY = 'papers';
const THUMB_PREFIX = 'thumb:';
const FAIL_PREFIX = 'thumbfail:';
const FAIL_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // retry failures after a week
const TARGET_WIDTH = 280; // 2x of the ~140px max display size
const THROTTLE_MS = 800;

/** Resolve a fetchable PDF URL for a paper, or null if we don't know one. */
export function pdfUrlFor(p) {
  if (!p) return null;
  if (p.source === 'arxiv' && p.sourceId) return `https://arxiv.org/pdf/${p.sourceId}`;
  if (p.source === 'openreview' && p.sourceId) return `https://openreview.net/pdf?id=${encodeURIComponent(p.sourceId)}`;
  if (p.url && /\.pdf(?:$|\?)/i.test(p.url)) return p.url;
  // CVF html page → sibling pdf
  if (p.source === 'cvf' && p.url && /\.html$/i.test(p.url)) {
    return p.url.replace('/html/', '/papers/').replace(/\.html$/i, '.pdf');
  }
  return null;
}

async function renderFirstPage(pdfUrl) {
  const task = pdfjsLib.getDocument({
    url: pdfUrl,
    disableAutoFetch: true,
    rangeChunkSize: 262144,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    try { await task.destroy(); } catch {}
  }
}

/** Remove thumb/fail keys whose paper no longer exists (deleted or merged). */
async function pruneOrphans(papers) {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(k => {
    if (k.startsWith(THUMB_PREFIX)) return !papers[k.slice(THUMB_PREFIX.length)];
    if (k.startsWith(FAIL_PREFIX)) return !papers[k.slice(FAIL_PREFIX.length)];
    return false;
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

let running = false;
let rerunRequested = false;

async function processQueue() {
  if (running) { rerunRequested = true; return; }
  running = true;
  try {
    const store = await chrome.storage.local.get(PAPERS_KEY);
    const papers = store[PAPERS_KEY] || {};
    await pruneOrphans(papers);

    for (const p of Object.values(papers)) {
      const url = pdfUrlFor(p);
      if (!url) continue;

      const thumbKey = THUMB_PREFIX + p.id;
      const failKey = FAIL_PREFIX + p.id;
      const cached = await chrome.storage.local.get([thumbKey, failKey]);
      if (cached[thumbKey]) continue;
      const failedAt = cached[failKey];
      if (failedAt && Date.now() - failedAt < FAIL_RETRY_MS) continue;

      try {
        const dataUrl = await renderFirstPage(url);
        await chrome.storage.local.set({ [thumbKey]: dataUrl });
        await chrome.storage.local.remove(failKey);
      } catch (err) {
        console.warn('[paperclip] thumbnail failed', p.id, err && err.message);
        await chrome.storage.local.set({ [failKey]: Date.now() });
      }
      await new Promise(r => setTimeout(r, THROTTLE_MS));
    }
  } finally {
    running = false;
    if (rerunRequested) {
      rerunRequested = false;
      processQueue();
    }
  }
}

// New papers arriving (capture / backfill / enrichment) should get thumbs too.
let kickTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PAPERS_KEY]) return;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(processQueue, 2000);
});

processQueue();
