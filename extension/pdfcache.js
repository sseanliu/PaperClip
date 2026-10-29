/**
 * pdfcache.js — keeps the bytes of PDFs the reader has opened in Cache
 * Storage, so reopening a paper doesn't download it again. That matters for
 * servers that ignore range requests and send no cache headers (NeurIPS
 * proceedings: every open re-sent the whole 7 MB file, 1-13 s).
 *
 * Least recently opened files go first once the total passes MAX_BYTES. The
 * index (url -> size, last use) lives in localStorage; nothing here touches
 * chrome.storage, so cache writes never trigger the library's re-render.
 */

const CACHE_NAME = 'paperclip-pdfs';
const INDEX_KEY = 'paperclip-pdf-cache-index';
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
// An unversioned arXiv link can gain a newer version; refetch after a month.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY)) || {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {}
}

/** Cached bytes for this PDF URL, or null. */
export async function getCachedPdf(url) {
  if (!url || typeof caches === 'undefined') return null;
  const index = readIndex();
  const entry = index[url];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > MAX_AGE_MS) {
    await removeCachedPdf(url);
    return null;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(url);
    if (!res) {
      delete index[url];
      writeIndex(index);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    entry.usedAt = Date.now();
    writeIndex(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Store a PDF's bytes, then evict least recently used files over the cap.
 * prefetched: saved by the thumbnail queue, not opened yet; such files go
 * before any paper actually read.
 */
export async function putCachedPdf(url, bytes, { prefetched = false } = {}) {
  if (!url || !bytes || typeof caches === 'undefined') return;
  const size = bytes.byteLength;
  if (!size || size > MAX_FILE_BYTES) return;
  // Only real PDFs: a login or challenge page must not be served as the paper.
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(bytes, {
      headers: { 'content-type': 'application/pdf', 'content-length': String(size) },
    }));
    const index = readIndex();
    const now = Date.now();
    index[url] = { size, savedAt: now, usedAt: prefetched ? 0 : now };
    let total = Object.values(index).reduce((sum, e) => sum + e.size, 0);
    const oldest = Object.entries(index).sort((a, b) =>
      a[1].usedAt - b[1].usedAt || a[1].savedAt - b[1].savedAt);
    for (const [key, e] of oldest) {
      if (total <= MAX_BYTES) break;
      if (key === url) continue;
      await cache.delete(key);
      delete index[key];
      total -= e.size;
    }
    writeIndex(index);
  } catch (err) {
    console.warn('[paperclip] could not cache PDF', url, err && err.message);
  }
}

export async function hasCachedPdf(url) {
  return !!(url && readIndex()[url]);
}

export async function removeCachedPdf(url) {
  const index = readIndex();
  delete index[url];
  writeIndex(index);
  try {
    await (await caches.open(CACHE_NAME)).delete(url);
  } catch {}
}
