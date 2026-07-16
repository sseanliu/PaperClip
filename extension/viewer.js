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

  if (!url) {
    showMessage('No direct PDF known for this paper.', paper.url);
    return;
  }

  showMessage('Loading PDF…');

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

document.addEventListener('DOMContentLoaded', () => {
  if (!els()) return;
  document.getElementById('pdfPanelClose').addEventListener('click', close);
  openTabBtn.addEventListener('click', () => {
    if (currentUrl) chrome.tabs.create({ url: currentUrl });
  });
});

window.PaperViewer = { open, close, isOpen, isOpenFor };
