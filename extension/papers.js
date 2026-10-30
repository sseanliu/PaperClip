/**
 * papers.js — URL classifier for academic papers.
 *
 * Loaded by both the service worker (via importScripts) and the new-tab page
 * (via <script src>). Defines globals on `self` so it works in both contexts.
 *
 * classifyPaper(url) → { source, sourceId, canonicalId, doi? } | null
 * readerTarget(url) → the PDF URL inside an index.html#<url> tab URL, or null
 *
 * canonicalId is what dedupes the same paper across multiple URL variants
 * (e.g. arxiv abs vs arxiv pdf vs arxiv html → same `arxiv:<id>`).
 */

(function () {
  function safeUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try { return new URL(raw); } catch { return null; }
  }

  function stripWww(host) {
    return (host || '').toLowerCase().replace(/^www\./, '');
  }

  // New-style (2401.12345) or old-style (cs/0301001, math.AG/0301001) IDs.
  function isValidArxivId(id) {
    return /^(\d{4}\.\d{4,5}|[a-z][a-z.\-]*\/\d{7})$/i.test(id || '');
  }

  // A PDF the browser opened in PaperClip: the tab shows the library with
  // the paper open, at chrome-extension://<id>/index.html#<the PDF's URL>.
  const READER_PAGE = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
    ? chrome.runtime.getURL('index.html')
    : null;

  function readerTarget(rawUrl) {
    if (!READER_PAGE || typeof rawUrl !== 'string' || !rawUrl.startsWith(READER_PAGE + '#')) return null;
    return rawUrl.slice(READER_PAGE.length + 1) || null;
  }

  const IGNORED_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);
  const DROPBOX_IGNORED_PARAMS = new Set(['e', 'dl', 'st', 'raw', 'download', 'from_auth', 'from_previews_auto_save']);

  function classifyPaper(rawUrl) {
    // The server said it's a PDF, so a reader URL is a paper even without
    // ".pdf" in its path.
    const wrapped = readerTarget(rawUrl);
    if (wrapped) rawUrl = wrapped;
    const u = safeUrl(rawUrl);
    if (!u) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const host = stripWww(u.hostname);
    const path = u.pathname;

    // ── arXiv ───────────────────────────────────────────────────────────────
    if (host === 'arxiv.org' || host === 'export.arxiv.org' || host === 'browse.arxiv.org') {
      // /abs/2401.12345, /pdf/2401.12345.pdf, /pdf/2401.12345v2, /html/2401.12345
      // also old-style: /abs/cs.LG/0301001
      const m = path.match(/^\/(?:abs|pdf|html|ps|format)\/([\w.\-]+(?:\/[\w.\-]+)?)(?:\.pdf)?\/?$/i);
      if (m) {
        const id = m[1].replace(/v\d+$/i, '');
        if (isValidArxivId(id)) return { source: 'arxiv', sourceId: id, canonicalId: `arxiv:${id}` };
      }
    }

    // ── OpenReview ─────────────────────────────────────────────────────────
    if (host === 'openreview.net') {
      if (/^\/(forum|pdf|attachment|notes)\/?$/i.test(path) || /^\/(forum|pdf|attachment|notes)\b/i.test(path)) {
        const id = u.searchParams.get('id');
        if (id) return { source: 'openreview', sourceId: id, canonicalId: `openreview:${id}` };
      }
    }

    // ── bioRxiv / medRxiv ──────────────────────────────────────────────────
    if (host === 'biorxiv.org' || host === 'medrxiv.org') {
      const m = path.match(/^\/content\/(10\.[^/]+\/[^/]+?)(?:v\d+)?(?:\.full(?:\.pdf)?)?\/?$/i);
      if (m) {
        const doi = m[1].toLowerCase();
        return {
          source: host === 'biorxiv.org' ? 'biorxiv' : 'medrxiv',
          sourceId: doi,
          doi,
          canonicalId: `doi:${doi}`
        };
      }
    }

    // ── ACM Digital Library ────────────────────────────────────────────────
    if (host === 'dl.acm.org') {
      const m = path.match(/^\/doi\/(?:abs\/|pdf\/|fullHtml\/|epdf\/)?(10\.[^/]+\/[^/]+)/i);
      if (m) {
        const doi = m[1].toLowerCase();
        return { source: 'acm', sourceId: doi, doi, canonicalId: `doi:${doi}` };
      }
    }

    // ── IEEE Xplore ────────────────────────────────────────────────────────
    if (host === 'ieeexplore.ieee.org') {
      const m = path.match(/^\/(?:abstract\/)?document\/(\d+)/i);
      if (m) return { source: 'ieee', sourceId: m[1], canonicalId: `ieee:${m[1]}` };
    }

    // ── SpringerLink ───────────────────────────────────────────────────────
    if (host === 'link.springer.com') {
      const m = path.match(/^\/(?:article|chapter|book|referenceworkentry)\/(10\.[^/]+\/[^/]+)/i);
      if (m) {
        const doi = m[1].toLowerCase();
        return { source: 'springer', sourceId: doi, doi, canonicalId: `doi:${doi}` };
      }
    }

    // ── Nature ─────────────────────────────────────────────────────────────
    if (host === 'nature.com' || host.endsWith('.nature.com')) {
      const m = path.match(/^\/articles\/([\w.\-]+?)(?:\.pdf)?\/?$/i);
      if (m) return { source: 'nature', sourceId: m[1], canonicalId: `nature:${m[1]}` };
    }

    // ── Science (AAAS) ─────────────────────────────────────────────────────
    if (host === 'science.org' || host.endsWith('.science.org')) {
      const m = path.match(/^\/doi\/(?:full\/|pdf\/|abs\/|epdf\/)?(10\.[^/]+\/[^/]+)/i);
      if (m) {
        const doi = m[1].toLowerCase();
        return { source: 'science', sourceId: doi, doi, canonicalId: `doi:${doi}` };
      }
    }

    // ── NeurIPS proceedings ────────────────────────────────────────────────
    if (host === 'papers.nips.cc' || host === 'proceedings.neurips.cc') {
      // /paper_files/paper/2024/hash/<hash>-Abstract-Conference.html
      // /paper_files/paper/2024/file/<hash>-Paper-Conference.pdf
      // /paper/2023/hash/<hash>-Paper.pdf, /paper/2023/hash/<hash>.html
      // The 32-hex hash names the paper; the abstract page and its PDF share it.
      const h = path.match(/^\/paper(?:_files)?\/paper\/(\d{4})\/(?:hash|file)\/([0-9a-f]{32})\b/i);
      if (h) {
        const id = `${h[1]}/${h[2].toLowerCase()}`;
        return { source: 'nips', sourceId: id, canonicalId: `nips:${id}` };
      }
      const m = path.match(/^\/paper(?:_files)?\/paper\/(\d{4})\/(?:hash\/)?([\w\-]+)/i);
      if (m && m[2] !== 'file') {
        const id = `${m[1]}/${m[2]}`;
        return { source: 'nips', sourceId: id, canonicalId: `nips:${id}` };
      }
    }

    // ── MLR (PMLR) ─────────────────────────────────────────────────────────
    if (host === 'proceedings.mlr.press') {
      const m = path.match(/^\/(v\d+)\/([\w\-]+?)(?:\.html|\.pdf)?\/?$/i);
      if (m) {
        const id = `${m[1]}/${m[2]}`;
        return { source: 'mlr', sourceId: id, canonicalId: `mlr:${id}` };
      }
    }

    // ── ACL Anthology ──────────────────────────────────────────────────────
    if (host === 'aclanthology.org') {
      // 2026.acl-long.1167, 2023.findings-emnlp.42; older D19-1670. The PDF
      // may also sit under /anthology-files/pdf/<venue>/.
      const m = path.match(/^\/(?:anthology-files\/pdf\/[\w\-]+\/)?(\d{4}\.[\w\-]+\.\d+|[A-Z]\d{2}-\d+)(?:\.pdf)?\/?$/);
      if (m) return { source: 'acl', sourceId: m[1], canonicalId: `acl:${m[1]}` };
    }

    // ── Semantic Scholar ───────────────────────────────────────────────────
    if (host === 'semanticscholar.org' || host.endsWith('.semanticscholar.org')) {
      const m = path.match(/^\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i);
      if (m) return { source: 'semanticscholar', sourceId: m[1], canonicalId: `s2:${m[1]}` };
    }

    // ── CVF Open Access (CVPR / ICCV / WACV) ───────────────────────────────
    if (host === 'openaccess.thecvf.com') {
      // /content/CVPR2026/papers/Surname_Title_Words_CVPR_2026_paper.pdf
      // /content/CVPR2026/html/Surname_..._paper.html
      // old style: /content_cvpr_2013/papers/Surname_..._2013_CVPR_paper.pdf
      const m = path.match(/\/([\w.\-]+?_(?:paper|supplemental))\.(?:pdf|html)$/i);
      if (m) {
        // The supplemental PDF is the same paper — collapse onto the paper stem.
        const stem = m[1].replace(/_supplemental$/i, '_paper');
        return { source: 'cvf', sourceId: stem, canonicalId: `cvf:${stem}` };
      }
    }

    // ── Generic PDF (fallback for any URL ending in .pdf) ──────────────────
    if (wrapped || /\.pdf$/i.test(path)) {
      // Normalize URL: drop fragment, keep query (some servers need it) but
      // not the parameters that don't pick the file, or one PDF becomes
      // several entries (Dropbox's e=2 / e=3, tracking tags).
      // The query is rebuilt only when something was dropped, so other ids
      // (and the thumbnails stored under them) keep their exact spelling.
      const params = new URLSearchParams(u.search);
      const ignored = [...params.keys()].filter((key) =>
        /^utm_/i.test(key) || IGNORED_PARAMS.has(key.toLowerCase())
        || (host === 'dropbox.com' && DROPBOX_IGNORED_PARAMS.has(key.toLowerCase())));
      ignored.forEach((key) => params.delete(key));
      const query = ignored.length ? (params.toString() ? `?${params}` : '') : (u.search || '');
      const norm = `${u.protocol}//${host}${path}${query}`;
      return { source: 'pdf', sourceId: null, canonicalId: `url:${norm}` };
    }

    return null;
  }

  // Expose to both service worker (self) and window contexts
  self.classifyPaper = classifyPaper;
  self.readerTarget = readerTarget;
  self.isValidArxivId = isValidArxivId;
})();
