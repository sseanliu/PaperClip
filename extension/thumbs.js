/**
 * thumbs.js — render first-page thumbnails for library entries.
 *
 * Runs in the new-tab page as an ES module. For each paper that has a
 * reachable PDF URL and no cached thumbnail, fetches the PDF (PDF.js uses
 * range requests, so only the bytes needed for page 1 are downloaded when
 * the server supports them), renders page 1 to a canvas, and stores two WebP
 * blobs in IndexedDB: `small` for list rows and `large` for gallery covers.
 *
 * Blobs stay on disk until an <img> shows them, so a page holds object URLs
 * rather than ~90 KB base64 strings per paper. Only one open page works the
 * queue at a time (Web Lock), and only while it is visible: a background tab
 * gets throttled or frozen by Chrome and would hold the lock without making
 * progress. Pages hear about new thumbnails over a BroadcastChannel and load
 * just those records.
 *
 * app.js reads window.PaperThumbs: ready, urlFor(id, size), onChange(fn).
 */

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const FAIL_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // retry failures after a week
const OPEN_PDF_RECHECK_MS = 30 * 24 * 60 * 60 * 1000; // re-ask OpenAlex monthly
const ARXIV_TITLE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const ARXIV_API_GAP_MS = 3000; // arXiv asks for one API call per 3 seconds
const LARGE_WIDTH = 480; // 2x of the ~240px max display size (gallery cards)
const SMALL_WIDTH = 120; // list rows show 44px-wide thumbnails
const THROTTLE_MS = 800;
// Every network step is bounded: one request that never answers would
// otherwise stall the whole queue while its page holds the lock.
const NET_TIMEOUT_MS = 20 * 1000;
const RENDER_TIMEOUT_MS = 60 * 1000;

// Bump to invalidate every cached thumbnail (e.g. after a size change); the
// queue then re-renders them all.
const THUMB_VERSION = 3;

// Thumbnails up to version 2 lived in chrome.storage.local as JPEG data URLs.
const LEGACY_THUMB_PREFIX = 'thumb:';
const LEGACY_FAIL_PREFIX = 'thumbfail:';
const LEGACY_VERSION_KEY = 'thumbver';

// ─── IndexedDB ──────────────────────────────────────────────────────────────

const DB_NAME = 'paperclip';
const STORE = 'thumbs'; // { id, v, small?: Blob, large?: Blob, failedAt?: number }

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const dbPromise = (() => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  return req(r);
})();

async function objectStore(mode) {
  return (await dbPromise).transaction(STORE, mode).objectStore(STORE);
}

async function getRecord(id) {
  return req((await objectStore('readonly')).get(id));
}

async function getAllRecords() {
  return req((await objectStore('readonly')).getAll());
}

async function putRecord(rec) {
  return req((await objectStore('readwrite')).put(rec));
}

async function deleteRecords(ids) {
  const s = await objectStore('readwrite');
  await Promise.all(ids.map(id => req(s.delete(id))));
}

// ─── Object URLs for this page ──────────────────────────────────────────────

const urls = new Map(); // paperId → { small?: string, large?: string }
const listeners = new Set();
const channel = new BroadcastChannel('paperclip-thumbs');

function setUrls(id, rec) {
  const old = urls.get(id);
  if (old) {
    if (old.small) URL.revokeObjectURL(old.small);
    if (old.large) URL.revokeObjectURL(old.large);
    urls.delete(id);
  }
  if (rec && (rec.small || rec.large)) {
    urls.set(id, {
      small: rec.small ? URL.createObjectURL(rec.small) : undefined,
      large: rec.large ? URL.createObjectURL(rec.large) : undefined,
    });
  }
}

function notify(ids) {
  for (const fn of listeners) {
    try { fn(ids); } catch (err) { console.warn('[paperclip] thumbs listener', err); }
  }
}

// Record this page's own writes and tell the other pages.
function announce(ids, recs) {
  ids.forEach((id, i) => setUrls(id, recs[i]));
  channel.postMessage({ ids });
  notify(ids);
}

channel.onmessage = async (e) => {
  const ids = (e.data && e.data.ids) || [];
  for (const id of ids) setUrls(id, await getRecord(id));
  notify(ids);
};

const ready = (async () => {
  try {
    for (const rec of await getAllRecords()) setUrls(rec.id, rec);
  } catch (err) {
    console.warn('[paperclip] could not load thumbnails', err);
  }
})();

window.PaperThumbs = {
  ready,
  /** Object URL for a paper's thumbnail; size is 'small' or 'large'. */
  urlFor(id, size = 'small') {
    const u = urls.get(id);
    if (!u) return undefined;
    return size === 'large' ? (u.large || u.small) : (u.small || u.large);
  },
  /** Subscribe to thumbnail changes; fn receives the changed paper IDs. */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Direct-download form of a link to a PDF: GitHub and Dropbox links usually
 * point at a preview page, and a #page= fragment is only for the viewer.
 */
function directPdfUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  u.hash = '';
  const host = u.hostname.replace(/^www\./, '');
  if (!/\.pdf$/i.test(u.pathname)) return null;
  // github.com/<owner>/<repo>/blob/<ref>/<path>.pdf → .../raw/<ref>/<path>.pdf
  if (host === 'github.com') {
    u.pathname = u.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/raw/');
    return u.href;
  }
  if (host === 'dropbox.com') {
    if (u.pathname.startsWith('/preview/')) return null; // needs the owner's session
    u.searchParams.set('dl', '1');
    return u.href;
  }
  return u.href;
}

/** Resolve a fetchable PDF URL for a paper, or null if we don't know one. */
export function pdfUrlFor(p) {
  if (!p) return null;
  if (p.source === 'arxiv' && p.sourceId) return `https://arxiv.org/pdf/${p.sourceId}`;
  // A known arXiv version beats publisher sites, which mostly block scripted
  // downloads (ACM, IEEE, OpenReview) or sit behind a paywall. It comes from
  // enrichment, or from a title search once the paper's own link failed.
  const arxivId = (p.externalIds && p.externalIds.ArXiv) || p.arxivTitleMatch;
  if (arxivId) return `https://arxiv.org/pdf/${arxivId}`;
  if (p.source === 'openreview' && p.sourceId) return `https://openreview.net/pdf?id=${encodeURIComponent(p.sourceId)}`;
  const url = p.url || '';
  const direct = directPdfUrl(url);
  if (direct) return direct;
  // CVF html page → sibling pdf
  if (p.source === 'cvf' && /\.html$/i.test(url)) {
    return url.replace('/html/', '/papers/').replace(/\.html$/i, '.pdf');
  }
  // NeurIPS abstract page …/hash/<h>-Abstract[-Track].html → …/file/<h>-Paper[-Track].pdf
  if (p.source === 'nips') {
    const m = url.match(/^(.*\/paper_files\/paper\/\d{4})\/hash\/([0-9a-f]+)-Abstract(-[\w]+)?\.html/i);
    if (m) return `${m[1]}/file/${m[2]}-Paper${m[3] || ''}.pdf`;
  }
  // PMLR proceedings.mlr.press/v202/gao23h[.html] → /v202/gao23h/gao23h.pdf
  if (p.source === 'mlr') {
    const m = url.match(/^https?:\/\/proceedings\.mlr\.press\/(v\d+)\/([\w-]+?)(?:\.html)?\/?(?:[?#].*)?$/i);
    if (m) return `https://proceedings.mlr.press/${m[1]}/${m[2]}/${m[2]}.pdf`;
  }
  // Nature research articles (s41…) have a .pdf sibling; news pieces (d41…) don't.
  if (p.source === 'nature' && /^s4/i.test(p.sourceId || '')) {
    return `https://www.nature.com/articles/${p.sourceId.replace(/\.e?pdf$/i, '')}.pdf`;
  }
  // Open-access copy found by DOI (see findOpenPdf below).
  if (p.openPdfUrl) return p.openPdfUrl;
  return null;
}

function doiOf(p) {
  return p.doi || (p.externalIds && p.externalIds.DOI) || null;
}

// Hosts that refuse scripted PDF downloads (bot challenges, logins); their
// links are only a last resort.
const BLOCKING_HOSTS = /(^|\.)(dl\.acm\.org|ieeexplore\.ieee\.org|openreview\.net|sciencedirect\.com|researchgate\.net)$/i;

/**
 * Find an open copy of a paper by DOI in OpenAlex, which lists every known
 * location (arXiv, author pages, repositories). Prefers arXiv, then hosts
 * that serve PDFs to scripts. Returns null when there is none.
 */
async function findOpenPdf(doi) {
  const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=locations`, {
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`openalex: HTTP ${r.status}`);
  const json = await r.json();
  const urls = (json.locations || []).map(l => l && l.pdf_url).filter(Boolean);
  const rank = (u) => {
    if (/^https?:\/\/(export\.)?arxiv\.org\//i.test(u)) return 0;
    try { return BLOCKING_HOSTS.test(new URL(u).hostname) ? 2 : 1; } catch { return 3; }
  };
  urls.sort((a, b) => rank(a) - rank(b));
  return urls[0] || null;
}

const TITLE_STOPWORDS = new Set('a an the of for and or in on to with via by from at as is are be its into using towards toward'.split(' '));

function titleWords(title) {
  return new Set(((title || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !TITLE_STOPWORDS.has(w)));
}

function canSearchArxivTitle(p) {
  if (p.source === 'arxiv' || (p.externalIds && p.externalIds.ArXiv)) return false;
  if (p.arxivTitleCheckedAt && Date.now() - p.arxivTitleCheckedAt < ARXIV_TITLE_RECHECK_MS) return false;
  // Skip "<Source>:<id>" placeholders and one- or two-word page titles
  // ("Dropbox"), which can't identify a paper.
  if (/^[\w ]+:\S+$/.test(p.title || '')) return false;
  return titleWords(p.title).size >= 3;
}

/**
 * The arXiv ID of a paper with (nearly) the same title, or null. Camera-ready
 * ACM / IEEE / OpenReview papers often have a preprint there, sometimes with
 * a slightly different title, so candidates from a keyword search are scored
 * by word overlap (Jaccard over non-stopwords) and accepted at 0.8.
 */
async function findArxivByTitle(title) {
  const want = titleWords(title);
  const terms = [...want].sort((a, b) => b.length - a.length).slice(0, 8);
  const query = terms.map(w => `ti:${w}`).join(' AND ');
  const r = await fetch(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=10`, {
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`arxiv search: HTTP ${r.status}`);
  const xml = await r.text();
  let best = null;
  let bestScore = 0;
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const t = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const id = (entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1];
    if (!t || !id) continue;
    const got = titleWords(t);
    const shared = [...want].filter(w => got.has(w)).length;
    const score = shared / (want.size + got.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = id.replace(/v\d+$/, '');
    }
  }
  return bestScore >= 0.8 ? best : null;
}

async function tryRender(p, url) {
  try {
    return { id: p.id, v: THUMB_VERSION, ...(await renderFirstPage(url)) };
  } catch (err) {
    console.warn('[paperclip] thumbnail failed', p.id, err && err.message);
    return { id: p.id, v: THUMB_VERSION, failedAt: Date.now(), url };
  }
}

async function shrink(source) {
  const bmp = await createImageBitmap(source, { resizeWidth: SMALL_WIDTH, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

async function renderFirstPage(pdfUrl) {
  const task = pdfjsLib.getDocument({
    url: pdfUrl,
    disableAutoFetch: true,
    rangeChunkSize: 262144,
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${RENDER_TIMEOUT_MS / 1000}s`)), RENDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([drawFirstPage(task), timeout]);
  } finally {
    clearTimeout(timer);
    // Also aborts a download or render still in flight after a timeout.
    try { await task.destroy(); } catch {}
  }
}

async function drawFirstPage(task) {
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: LARGE_WIDTH / base.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  const large = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.8));
  const small = await shrink(canvas);
  return { large, small };
}

/**
 * Move version-2 thumbnails (data URLs in chrome.storage.local) into
 * IndexedDB, keeping the existing 480px JPEG as the large image, then drop
 * the old keys. One that can't be decoded gets a record with failedAt 0, so
 * the queue re-renders it from the PDF instead of losing it.
 */
async function migrateLegacy() {
  const keys = (await chrome.storage.local.getKeys()).filter(k =>
    k.startsWith(LEGACY_THUMB_PREFIX) || k.startsWith(LEGACY_FAIL_PREFIX) || k === LEGACY_VERSION_KEY);
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    const got = await chrome.storage.local.get(batch);
    const ids = [];
    const recs = [];
    for (const [k, v] of Object.entries(got)) {
      let rec = null;
      if (k.startsWith(LEGACY_THUMB_PREFIX) && typeof v === 'string') {
        const id = k.slice(LEGACY_THUMB_PREFIX.length);
        try {
          const large = await (await fetch(v)).blob();
          rec = { id, v: THUMB_VERSION, large, small: await shrink(large) };
        } catch (err) {
          console.warn('[paperclip] could not migrate thumbnail', k, err && err.message);
          rec = { id, v: THUMB_VERSION, failedAt: 0 };
        }
      } else if (k.startsWith(LEGACY_FAIL_PREFIX) && typeof v === 'number') {
        rec = { id: k.slice(LEGACY_FAIL_PREFIX.length), v: THUMB_VERSION, failedAt: v };
      }
      if (!rec) continue;
      await putRecord(rec);
      ids.push(rec.id);
      recs.push(rec);
    }
    await chrome.storage.local.remove(batch);
    if (ids.length) announce(ids, recs);
  }
}

let running = false;
let rerunRequested = false;

async function workQueue() {
  await migrateLegacy();
  const papers = await PaperStore.all();
  const records = new Map((await getAllRecords()).map(r => [r.id, r]));

  // Remove thumbnails whose paper no longer exists (deleted or merged).
  const orphans = [...records.keys()].filter(id => !papers.has(id));
  if (orphans.length) {
    await deleteRecords(orphans);
    announce(orphans, orphans.map(() => null));
  }

  // Newest first, so a paper you just opened isn't waiting behind retries.
  const order = [...papers.values()].sort((a, b) =>
    (b.firstSeenAt || '').localeCompare(a.firstSeenAt || ''));
  for (let p of order) {
    // Hand the queue to whichever page is visible next.
    if (document.hidden) return;
    const rec = records.get(p.id);
    const current = rec && rec.v === THUMB_VERSION;
    if (current && (rec.small || rec.large)) continue;

    let url = pdfUrlFor(p);
    // No PDF link from the source page (ACM, IEEE, paywalled publishers):
    // ask OpenAlex for an open copy and remember the answer on the paper,
    // so the side peek can open it too.
    const doi = doiOf(p);
    if (!url && doi && !(p.openPdfCheckedAt && Date.now() - p.openPdfCheckedAt < OPEN_PDF_RECHECK_MS)) {
      let found;
      try {
        found = await findOpenPdf(doi);
      } catch (err) {
        console.warn('[paperclip] open PDF lookup failed', p.id, err && err.message);
        continue;
      }
      p = (await PaperStore.update(p.id, (x) => {
        x.openPdfUrl = found;
        x.openPdfCheckedAt = Date.now();
      })) || p;
      url = pdfUrlFor(p);
      await new Promise(r => setTimeout(r, THROTTLE_MS));
    }

    // A failure is retried after a week, or at once if the URL we would try
    // has changed (new link rules, an open copy found later).
    const knownBad = current && rec.failedAt && rec.url === url;
    let next = null;
    if (url && !(knownBad && Date.now() - rec.failedAt < FAIL_RETRY_MS)) {
      next = await tryRender(p, url);
    }

    // Last resort: the same title on arXiv, for papers with no PDF link or a
    // link that fails (bot-blocked publishers, paywalls, expired links).
    if ((!url || knownBad || (next && next.failedAt)) && canSearchArxivTitle(p)) {
      let match;
      try {
        match = await findArxivByTitle(p.title);
      } catch (err) {
        console.warn('[paperclip] arXiv title search failed', p.id, err && err.message);
      }
      if (match !== undefined) {
        p = (await PaperStore.update(p.id, (x) => {
          x.arxivTitleMatch = match;
          x.arxivTitleCheckedAt = Date.now();
        })) || p;
        if (match) next = await tryRender(p, pdfUrlFor(p));
      }
      await new Promise(r => setTimeout(r, ARXIV_API_GAP_MS));
    }

    if (!next) continue;
    await putRecord(next);
    announce([p.id], [next]);
    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }
}

async function processQueue() {
  if (document.hidden) return;
  if (running) { rerunRequested = true; return; }
  running = true;
  try {
    // Another open new-tab page may already be working the queue.
    await navigator.locks.request('paperclip-thumbs', { ifAvailable: true }, async (lock) => {
      if (lock) await workQueue();
    });
  } catch (err) {
    console.warn('[paperclip] thumbnail queue', err);
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
PaperStore.onChange(() => {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(processQueue, 2000);
});

// A page that became visible picks up the queue (another page may have
// stopped when it went to the background).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) processQueue();
});

processQueue();
