/**
 * viewer.js — Notion-style side peek that renders a paper's PDF in a panel
 * on the right side of the new-tab page.
 *
 * Uses the bundled PDF.js build (same as thumbs.js), so it works even for
 * sites that forbid iframe embedding — we fetch the PDF ourselves and paint
 * pages onto canvases. Pages render lazily as they scroll into view.
 *
 * Exposes window.PaperViewer = { open(paper), close(), isOpen() } for app.js
 * (a non-module script) to call.
 */

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { pdfUrlFor } from './thumbs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const PAGE_GAP_SELECTOR_MARGIN = '600px'; // pre-render pages this far from view

let panel, titleEl, bodyEl, openTabBtn;
let currentDoc = null;
let currentPaperId = null;
let currentUrl = null;
let pageObserver = null;
let renderGeneration = 0; // invalidates in-flight renders when doc changes

function els() {
  panel = panel || document.getElementById('pdfPanel');
  titleEl = titleEl || document.getElementById('pdfPanelTitle');
  bodyEl = bodyEl || document.getElementById('pdfPanelBody');
  openTabBtn = openTabBtn || document.getElementById('pdfPanelOpenTab');
  return panel && titleEl && bodyEl && openTabBtn;
}

async function teardownDoc() {
  renderGeneration++;
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

  const containerWidth = holder.clientWidth || bodyEl.clientWidth - 32;
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

async function open(paper) {
  if (!els() || !paper) return;

  const url = pdfUrlFor(paper);
  currentPaperId = paper.id;
  currentUrl = url || paper.url || null;

  titleEl.textContent = paper.title || paper.url || 'Untitled';
  titleEl.title = titleEl.textContent;
  panel.hidden = false;
  document.body.classList.add('pdf-panel-open');

  await teardownDoc();
  const generation = renderGeneration;
  bodyEl.classList.remove('is-frame');

  if (!url) {
    showMessage('No direct PDF known for this paper.', paper.url);
    return;
  }

  showMessage('Loading PDF…');

  // Preferred path: embed the PDF URL directly so the user's own PDF viewer
  // (Chrome's built-in, Google Scholar PDF Reader, …) handles it — same as
  // Overleaf's preview pane. Fall back to our PDF.js renderer only when the
  // site forbids framing.
  if (await canFrame(url)) {
    if (generation !== renderGeneration) return;
    bodyEl.innerHTML = '';
    bodyEl.classList.add('is-frame');
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    frame.src = url;
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
    });
    doc = await task.promise;
  } catch (err) {
    console.warn('[paperclip] pdf preview failed', paper.id, err && err.message);
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
  document.body.classList.remove('pdf-panel-open');
  currentPaperId = null;
  currentUrl = null;
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

// ─── Divider drag: resize the panel; pages rescale live (CSS) and
// re-render crisply at the new width once the drag ends. ───────────────────

const PEEK_WIDTH_KEY = 'paperclip-peek-width';

function applyPeekWidth(px) {
  document.documentElement.style.setProperty('--peek-w', `${Math.round(px)}px`);
}

function clampPeekWidth(px) {
  const min = 320;
  const max = Math.max(min, window.innerWidth * 0.8);
  return Math.min(max, Math.max(min, px));
}

async function rerenderVisiblePages() {
  if (!currentDoc || !bodyEl) return;
  const generation = renderGeneration;
  const holders = [...bodyEl.querySelectorAll('.pdf-page')];
  for (const holder of holders) {
    if (generation !== renderGeneration) return;
    if (!holder.querySelector('canvas')) continue; // placeholder — observer handles it
    const n = parseInt(holder.dataset.page, 10);
    try {
      await renderPageInto(holder, n, generation);
    } catch (err) {
      console.warn('[paperclip] page rerender failed', n, err && err.message);
    }
  }
}

function initResizer() {
  const resizer = document.getElementById('pdfPanelResizer');
  if (!resizer) return;

  const saved = parseInt(localStorage.getItem(PEEK_WIDTH_KEY) || '', 10);
  if (saved) applyPeekWidth(clampPeekWidth(saved));

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('pdf-panel-resizing');
    let width = panel.getBoundingClientRect().width;

    const onMove = (ev) => {
      width = clampPeekWidth(window.innerWidth - ev.clientX);
      applyPeekWidth(width);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('pdf-panel-resizing');
      localStorage.setItem(PEEK_WIDTH_KEY, String(Math.round(width)));
      rerenderVisiblePages();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isOpen()) close();
});

document.addEventListener('DOMContentLoaded', () => {
  if (!els()) return;
  document.getElementById('pdfPanelClose').addEventListener('click', close);
  openTabBtn.addEventListener('click', () => {
    if (currentUrl) chrome.tabs.create({ url: currentUrl });
  });
  initResizer();
});

window.PaperViewer = { open, close, isOpen, isOpenFor };
