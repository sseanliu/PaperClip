/**
 * viewer.js — paper reader: a window centered over the new-tab page (with a
 * dimmed backdrop) that renders a paper's PDF. The library underneath keeps
 * its layout.
 *
 * Uses the bundled PDF.js build (same as thumbs.js), so it works even for
 * sites that forbid iframe embedding — we fetch the PDF ourselves and paint
 * pages onto canvases. Pages render lazily as they scroll into view.
 *
 * Exposes window.PaperViewer = { open(paper, { focus }), close(), isOpen(),
 * isOpenFor(id), current() } for app.js (a non-module script) to call, and
 * fires a `paperviewer:change` event on document whenever the open paper
 * changes (detail { paper, pdfUrl, focus }, or null once closed; focus is
 * true when the user opened it, false for a keyboard preview).
 */

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { pdfUrlFor } from './thumbs.js';
import { getCachedPdf, putCachedPdf } from './pdfcache.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const PAGE_GAP_SELECTOR_MARGIN = '600px'; // pre-render pages this far from view

let panel, backdrop, titleEl, bodyEl, openTabBtn;
let currentDoc = null;
let currentPaperId = null;
let currentPaper = null;
let currentUrl = null;
let pageObserver = null;
let renderGeneration = 0; // invalidates in-flight renders when doc changes

function els() {
  panel = panel || document.getElementById('pdfPanel');
  backdrop = backdrop || document.getElementById('pdfBackdrop');
  titleEl = titleEl || document.getElementById('pdfPanelTitle');
  bodyEl = bodyEl || document.getElementById('pdfPanelBody');
  openTabBtn = openTabBtn || document.getElementById('pdfPanelOpenTab');
  return panel && titleEl && bodyEl && openTabBtn;
}

let lectorHolder = null;

function teardownLector() {
  if (lectorHolder) {
    if (window.LectorPanel) window.LectorPanel.unmount(lectorHolder);
    lectorHolder = null;
  }
  bodyEl && bodyEl.classList.remove('is-lector');
}

async function teardownDoc() {
  renderGeneration++;
  teardownLector();
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  if (currentDoc) {
    try { await currentDoc.destroy(); } catch {}
    currentDoc = null;
  }
}

function showMessage(text, url) {
  bodyEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'pdf-panel-message';
  msg.textContent = text;
  bodyEl.appendChild(msg);
  if (url) {
    const btn = document.createElement('button');
    btn.className = 'pdf-panel-fallback-btn';
    btn.textContent = 'Open in a tab instead';
    btn.addEventListener('click', () => chrome.tabs.create({ url }));
    bodyEl.appendChild(btn);
  }
}

async function renderPageInto(holder, pageNum, generation) {
  if (!currentDoc || generation !== renderGeneration) return;
  const page = await currentDoc.getPage(pageNum);
  if (generation !== renderGeneration) return;

  const containerWidth = holder.clientWidth || Math.min(READING_WIDTH, bodyEl.clientWidth - 32);
  const base = page.getViewport({ scale: 1 });
  const cssScale = containerWidth / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: cssScale * dpr });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  if (generation !== renderGeneration) return;
  holder.innerHTML = '';
  holder.style.aspectRatio = ''; // real canvas defines the height now
  holder.appendChild(canvas);
}

/**
 * Can this URL be embedded in an iframe? Checks X-Frame-Options /
 * CSP frame-ancestors via a HEAD request (host permissions let us read the
 * headers). Unknown/unreachable → assume yes; the PDF.js fallback stays one
 * click away either way.
 */
async function canFrame(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
    const csp = r.headers.get('content-security-policy') || '';
    const m = csp.match(/frame-ancestors\s+([^;]+)/i);
    if (m && !m[1].includes('*')) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Give the reader keyboard focus, so arrows and space scroll the paper. The
 * Lector viewer mounts asynchronously; focus its scroll root once it exists.
 */
function focusReader(tries = 20) {
  const root = document.getElementById('lectorRoot');
  if (root) {
    root.focus({ preventScroll: true });
    return;
  }
  bodyEl.focus({ preventScroll: true });
  if (tries > 0 && bodyEl.classList.contains('is-lector')) {
    setTimeout(() => focusReader(tries - 1), 50);
  }
}

// The window fills the screen; a paper opens at a comfortable reading width
// inside it, and zoom scales the paper within the window.
const READING_WIDTH = 1000;

async function open(paper, { focus = false } = {}) {
  if (!els() || !paper) return;

  const url = pdfUrlFor(paper);
  currentPaperId = paper.id;
  currentPaper = paper;
  currentUrl = url || paper.url || null;
  document.dispatchEvent(new CustomEvent('paperviewer:change', { detail: { paper, pdfUrl: url, focus } }));
  // Reading a paper here counts as opening it ("Recently opened" sort); a
  // keyboard preview while moving through the list doesn't.
  if (focus) {
    PaperStore.update(paper.id, (p) => { p.lastSeenAt = new Date().toISOString(); }).catch(() => {});
  }

  titleEl.textContent = paper.title || paper.url || 'Untitled';
  titleEl.title = titleEl.textContent;
  panel.hidden = false;
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('pdf-panel-open');

  await teardownDoc();
  const generation = renderGeneration;
  bodyEl.classList.remove('is-frame');

  if (!url) {
    showMessage('No direct PDF known for this paper.', paper.url);
    return;
  }

  showMessage('Loading PDF…');

  // Preferred path: the Lector viewer (headless pdf.js primitives) - fully
  // controlled, fit-to-width from first paint, real text selection. Falls
  // back to the iframe embed if it errors (e.g. cross-origin fetch refused).
  if (window.LectorPanel) {
    // A paper opened before comes from the local cache, not the network.
    const cached = await getCachedPdf(url);
    if (generation !== renderGeneration) return;
    bodyEl.innerHTML = '';
    bodyEl.classList.add('is-lector');
    const holder = document.createElement('div');
    holder.className = 'lector-holder';
    bodyEl.appendChild(holder);
    lectorHolder = holder;
    window.LectorPanel.mount(holder, cached || url, {
      pageWidth: READING_WIDTH,
      // The Lector toolbar carries the title and window buttons; the panel
      // header is hidden in this mode.
      title: titleEl.textContent,
      onClose: close,
      // Once the whole file has arrived, keep it for the next open.
      onLoad: cached ? undefined : (proxy) => {
        proxy.getDownloadInfo()
          .then(() => proxy.getData())
          .then((bytes) => putCachedPdf(url, bytes))
          .catch(() => {});
      },
      onOpenTab: () => { if (currentUrl) chrome.tabs.create({ url: currentUrl }); },
      onError: () => {
        if (generation !== renderGeneration) return;
        teardownLector();
        openFrameOrCanvas(url, generation);
      },
    });
    if (focus) focusReader();
    return;
  }
  openFrameOrCanvas(url, generation);
  if (focus) focusReader();
}

async function openFrameOrCanvas(url, generation) {
  // Iframe path: embed the PDF URL directly so the user's own PDF viewer
  // (Chrome's built-in, Google Scholar PDF Reader, …) handles it — same as
  // Overleaf's preview pane. Fall back to our PDF.js renderer only when the
  // site forbids framing.
  if (await canFrame(url)) {
    if (generation !== renderGeneration) return;
    bodyEl.innerHTML = '';
    bodyEl.classList.add('is-frame');
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    frame.src = url + (url.includes('#') ? '&' : '#') + 'view=FitH';
    frame.title = titleEl.textContent;
    bodyEl.appendChild(frame);
    return;
  }
  if (generation !== renderGeneration) return;

  let doc;
  try {
    const task = pdfjsLib.getDocument({
      url,
      disableAutoFetch: true,
      rangeChunkSize: 262144,
      // Same pdf.js copy as the thumbnails: no @font-face registration, so
      // its font names can't collide with the Lector reader's (see thumbs.js).
      disableFontFace: true,
    });
    doc = await task.promise;
  } catch (err) {
    console.warn('[paperclip] pdf preview failed', url, err && err.message);
    if (generation === renderGeneration) {
      showMessage("Couldn't load this PDF here.", url);
    }
    return;
  }
  if (generation !== renderGeneration) {
    try { await doc.destroy(); } catch {}
    return;
  }
  currentDoc = doc;

  bodyEl.innerHTML = '';
  bodyEl.scrollTop = 0;

  // First page tells us the aspect ratio to use for all placeholders, so
  // the scrollbar is roughly correct before pages render.
  const first = await doc.getPage(1);
  if (generation !== renderGeneration) return;
  const vp1 = first.getViewport({ scale: 1 });
  const aspect = `${vp1.width} / ${vp1.height}`;

  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const holder = entry.target;
      pageObserver.unobserve(holder);
      const n = parseInt(holder.dataset.page, 10);
      renderPageInto(holder, n, generation).catch(err => {
        console.warn('[paperclip] page render failed', n, err && err.message);
      });
    }
  }, { root: bodyEl, rootMargin: PAGE_GAP_SELECTOR_MARGIN });

  for (let n = 1; n <= doc.numPages; n++) {
    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.dataset.page = String(n);
    holder.style.aspectRatio = aspect;
    bodyEl.appendChild(holder);
    pageObserver.observe(holder);
  }
}

async function close() {
  if (!els()) return;
  panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('pdf-panel-open');
  currentPaperId = null;
  currentPaper = null;
  currentUrl = null;
  document.dispatchEvent(new CustomEvent('paperviewer:change', { detail: null }));
  await teardownDoc();
  bodyEl.classList.remove('is-frame');
  bodyEl.innerHTML = '';
}

function isOpen() {
  return !!(panel && !panel.hidden);
}

function isOpenFor(paperId) {
  return isOpen() && currentPaperId === paperId;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isOpen()) close();
});

/**
 * The reader has no visible frame, so a click on the open space beside the
 * pages closes it like a backdrop click. Clicks on a page, the toolbar or a
 * side pane don't, and neither does finishing a text selection.
 */
function closeOnOpenSpace(e) {
  if (!bodyEl.classList.contains('is-lector')) return;
  if (window.getSelection && window.getSelection().toString()) return;
  if (e.target.closest('.lector-toolbar, .lector-thumbs, .lector-search-pane, a, button, input')) return;
  for (const canvas of bodyEl.querySelectorAll('.lector-pages canvas')) {
    const r = canvas.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
  }
  close();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!els()) return;
  document.getElementById('pdfPanelClose').addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
  bodyEl.addEventListener('click', closeOnOpenSpace);
  openTabBtn.addEventListener('click', () => {
    if (currentUrl) chrome.tabs.create({ url: currentUrl });
  });
});

function current() {
  return currentPaper ? { paper: currentPaper, pdfUrl: pdfUrlFor(currentPaper) } : null;
}

window.PaperViewer = { open, close, isOpen, isOpenFor, current };
