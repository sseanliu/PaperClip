/**
 * reader.js — the tab a PDF opens in. The background's redirect rule sends
 * a page served as a PDF to reader.html#<its URL>; this shows it in the same
 * reader as the library (Claude chat, selection translation, the PDF cache),
 * with Download and "Open in Chrome's PDF viewer" in the toolbar.
 */

import { getCachedPdf } from './pdfcache.js';

const pdfUrl = location.hash.slice(1);

// Another page could frame this one to show a PDF under its own UI.
const framed = window.top !== window;

function fileName(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    return /\.pdf$/i.test(last) ? last : `${last}.pdf`;
  } catch {
    return 'paper.pdf';
  }
}

async function download() {
  try {
    let bytes = await getCachedPdf(pdfUrl);
    if (!bytes) {
      const res = await fetch(pdfUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = fileName(pdfUrl);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60 * 1000);
  } catch (err) {
    console.warn('[paperclip] download failed', pdfUrl, err && err.message);
    openNative();
  }
}

function openNative() {
  chrome.runtime.sendMessage({ type: 'paperclip:open-native', url: pdfUrl });
}

// A title worth showing: not empty, a URL, a file name, or the
// "<Source>:<id>" stand-in the library saves before metadata arrives.
function realTitle(t) {
  return !!t && !/^[a-z][\w-]*:\S+$/i.test(t.trim()) && !/^[\w.-]+\.pdf$/i.test(t.trim());
}

async function start() {
  if (framed || !/^https?:\/\//i.test(pdfUrl)) {
    document.body.textContent = '';
    return;
  }
  const cls = classifyPaper(pdfUrl);
  const id = cls ? cls.canonicalId : `url:${pdfUrl}`;
  const known = cls && await PaperStore.findByIdOrAlias(cls.canonicalId);
  const name = fileName(pdfUrl);
  const titled = !!known && realTitle(known.title);
  const paper = titled ? known : { ...(known || { id, url: pdfUrl, source: cls ? cls.source : 'pdf' }), title: name };
  document.title = paper.title;

  // Metadata (arXiv, Semantic Scholar) may name the paper a moment later.
  PaperStore.onChange(async () => {
    const p = await PaperStore.findByIdOrAlias(id);
    if (!p || !realTitle(p.title) || document.title === p.title) return;
    document.title = p.title;
    window.PaperViewer.setTitle(p.title);
  });

  window.PaperViewer.open(paper, {
    focus: true,
    pdfUrl,
    standalone: {
      onDownload: download,
      onOpenNative: openNative,
      // An unknown paper takes the PDF's own title, as Chrome's viewer
      // shows it; the background captures the paper with this tab title.
      onDocument: (proxy) => {
        if (titled) return;
        proxy.getMetadata().then(({ info }) => {
          const title = info && typeof info.Title === 'string' ? info.Title.trim() : '';
          if (!realTitle(title) || realTitle(document.title)) return;
          document.title = title;
          window.PaperViewer.setTitle(title);
        }).catch(() => {});
      },
    },
  });
}

// Another PDF in this tab can arrive as a hash change on this same page.
window.addEventListener('hashchange', () => location.reload());

start();
