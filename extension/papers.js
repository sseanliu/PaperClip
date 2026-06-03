/**
 * papers.js — URL classifier for academic papers.
 *
 * Loaded by both the service worker (via importScripts) and the new-tab page
 * (via <script src>). Defines globals on `self` so it works in both contexts.
 *
 * classifyPaper(url) → { source, sourceId, canonicalId, doi? } | null
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

  function classifyPaper(rawUrl) {
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
        return { source: 'arxiv', sourceId: id, canonicalId: `arxiv:${id}` };
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
      // Common forms:
      // /document/8678448
      // /abstract/document/8678448
      // /stamp/stamp.jsp?tp=&arnumber=8678448
      // /stampPDF/getPDF.jsp?tp=&arnumber=8678448
      const m = path.match(/^\/(?:abstract\/)?document\/(\d+)/i);
      if (m) return { source: 'ieee', sourceId: m[1], canonicalId: `ieee:${m[1]}` };

      const arnumber = u.searchParams.get('arnumber');
      if (arnumber && /^\d+$/.test(arnumber)) {
        if (/^\/stamp(?:PDF)?\//i.test(path) || /\/stamp\.jsp$/i.test(path)) {
          return { source: 'ieee', sourceId: arnumber, canonicalId: `ieee:${arnumber}` };
        }
      }
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
      // /paper_files/paper/2024/hash/abc-Paper-Conference.pdf
      // /paper/2023/hash/abc-Paper.pdf
      // /paper/2023/hash/abc.html
      const m = path.match(/^\/paper(?:_files)?\/paper\/(\d{4})\/(?:hash\/)?([\w\-]+)/i);
      if (m) {
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
      const m = path.match(/^\/(\d{4}\.[\w\-]+|[A-Z]\d{2}-\d+)(?:\.pdf)?\/?$/);
      if (m) return { source: 'acl', sourceId: m[1], canonicalId: `acl:${m[1]}` };
    }

    // ── Semantic Scholar ───────────────────────────────────────────────────
    if (host === 'semanticscholar.org' || host.endsWith('.semanticscholar.org')) {
      const m = path.match(/^\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i);
      if (m) return { source: 'semanticscholar', sourceId: m[1], canonicalId: `s2:${m[1]}` };
    }

    // ── Generic PDF (fallback for any URL ending in .pdf) ──────────────────
    if (/\.pdf$/i.test(path)) {
      // Normalize URL: drop fragment, keep query (some servers need it)
      const norm = `${u.protocol}//${host}${path}${u.search || ''}`;
      return { source: 'pdf', sourceId: null, canonicalId: `url:${norm}` };
    }

    return null;
  }

  // Expose to both service worker (self) and window contexts
  self.classifyPaper = classifyPaper;
})();
