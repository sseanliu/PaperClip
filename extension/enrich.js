/**
 * enrich.js — fetch paper metadata from public APIs.
 *
 * Loaded by the service worker via importScripts. Exposes
 * self.PaperEnrich.enrich(paper) → Promise<patches | null>.
 *
 * Returning null means "no enrichment path for this source"; throwing means
 * a network/parse error and the caller should mark the entry failed.
 */

(function () {
  // ─── XML helpers (no DOMParser in service workers) ────────────────────────

  function decodeXml(s) {
    return (s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&amp;/g, '&');
  }

  function cleanWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function firstTagText(xml, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
    const m = xml.match(re);
    return m ? decodeXml(m[1]) : '';
  }

  // ─── Per-source fetchers ──────────────────────────────────────────────────

  async function enrichArxiv(paper) {
    const id = paper.sourceId;
    if (!id) return null;

    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`arxiv: HTTP ${r.status}`);
    const xml = await r.text();

    const entryMatch = xml.match(/<entry\b[\s\S]*?<\/entry>/);
    if (!entryMatch) throw new Error('arxiv: no entry');
    const entry = entryMatch[0];

    const title = firstTagText(entry, 'title');
    const summary = firstTagText(entry, 'summary');
    const published = firstTagText(entry, 'published');
    const year = published ? parseInt(published.slice(0, 4), 10) : null;

    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
      .map(m => cleanWhitespace(decodeXml(m[1])))
      .filter(Boolean);

    const journalMatch = entry.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/);
    const venue = journalMatch ? cleanWhitespace(decodeXml(journalMatch[1])) : null;

    const out = {
      title: cleanWhitespace(title),
      authors,
      year,
      abstract: cleanWhitespace(summary),
    };
    if (venue) out.venue = venue;
    return out;
  }

  // ─── OpenReview ───────────────────────────────────────────────────────────

  function pickOpenReviewField(content, key) {
    const v = content && content[key];
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && 'value' in v) return v.value;
    return null;
  }

  async function enrichOpenReview(paper) {
    const id = paper.sourceId;
    if (!id) return null;
    const url = `https://api.openreview.net/notes?id=${encodeURIComponent(id)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`openreview: HTTP ${r.status}`);
    const json = await r.json();
    const note = json && json.notes && json.notes[0];
    if (!note) throw new Error('openreview: no note');

    const c = note.content || {};
    const title = pickOpenReviewField(c, 'title');
    const authorsField = pickOpenReviewField(c, 'authors');
    const venue = pickOpenReviewField(c, 'venue') || pickOpenReviewField(c, 'venueid');
    const abstract = pickOpenReviewField(c, 'abstract');

    let authors = [];
    if (Array.isArray(authorsField)) {
      authors = authorsField.map(a => cleanWhitespace(String(a))).filter(Boolean);
    } else if (typeof authorsField === 'string') {
      authors = authorsField.split(/\s*,\s*|\s* and \s*/).map(cleanWhitespace).filter(Boolean);
    }

    let year = null;
    if (note.cdate) {
      const d = new Date(note.cdate);
      if (!isNaN(d)) year = d.getFullYear();
    }

    const out = { title: cleanWhitespace(title), authors };
    if (year) out.year = year;
    if (venue) out.venue = cleanWhitespace(venue);
    if (abstract) out.abstract = cleanWhitespace(abstract);
    return out;
  }

  // ─── Crossref (DOI-based: biorxiv/medrxiv/acm/springer/science) ───────────

  function stripHtml(s) {
    return (s || '').replace(/<[^>]+>/g, '');
  }

  async function enrichCrossref(paper) {
    const doi = paper.doi || paper.sourceId;
    if (!doi) return null;
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'PaperClip/1.0 (Chrome extension)' }
    });
    if (!r.ok) throw new Error(`crossref: HTTP ${r.status}`);
    const json = await r.json();
    const m = json && json.message;
    if (!m) throw new Error('crossref: no message');

    const title = (Array.isArray(m.title) ? m.title[0] : m.title) || '';
    const venue = (Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title']) || null;

    const authors = Array.isArray(m.author)
      ? m.author.map(a => cleanWhitespace(`${a.given || ''} ${a.family || ''}`)).filter(Boolean)
      : [];

    let year = null;
    const dp = (m['published-print'] || m['published-online'] || m.issued || {})['date-parts'];
    if (Array.isArray(dp) && Array.isArray(dp[0]) && dp[0][0]) year = dp[0][0];

    const abstract = m.abstract ? cleanWhitespace(stripHtml(m.abstract)) : null;

    const out = { title: cleanWhitespace(title), authors };
    if (year) out.year = year;
    if (venue) out.venue = cleanWhitespace(venue);
    if (abstract) out.abstract = abstract;
    return out;
  }

  // ─── Semantic Scholar (fallback for ieee/nature/nips/mlr/acl/s2/pdf) ──────

  async function enrichSemanticScholar(paper) {
    let identifier;
    switch (paper.source) {
      case 'semanticscholar':
        identifier = paper.sourceId; // 40-char hash
        break;
      case 'ieee':
        // Semantic Scholar doesn't accept IEEE doc IDs directly. Try URL lookup.
        identifier = `URL:${paper.url}`;
        break;
      case 'nature':
      case 'nips':
      case 'mlr':
      case 'acl':
      case 'pdf':
        identifier = `URL:${paper.url}`;
        break;
      default:
        return null;
    }
    if (!identifier) return null;

    const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(identifier)}?fields=title,authors,year,venue,abstract`;
    const r = await fetch(url);
    if (r.status === 404) return null; // S2 doesn't know this paper — give up gracefully
    if (!r.ok) throw new Error(`s2: HTTP ${r.status}`);
    const json = await r.json();
    if (!json || !json.title) return null;

    const authors = Array.isArray(json.authors)
      ? json.authors.map(a => cleanWhitespace(a && a.name)).filter(Boolean)
      : [];

    const out = { title: cleanWhitespace(json.title), authors };
    if (json.year) out.year = json.year;
    if (json.venue) out.venue = cleanWhitespace(json.venue);
    if (json.abstract) out.abstract = cleanWhitespace(json.abstract);
    return out;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  async function enrich(paper) {
    if (!paper) return null;
    switch (paper.source) {
      case 'arxiv':
        return await enrichArxiv(paper);
      case 'openreview':
        return await enrichOpenReview(paper);
      case 'biorxiv':
      case 'medrxiv':
      case 'acm':
      case 'springer':
      case 'science':
        return await enrichCrossref(paper);
      case 'ieee':
      case 'nature':
      case 'nips':
      case 'mlr':
      case 'acl':
      case 'semanticscholar':
      case 'pdf':
        return await enrichSemanticScholar(paper);
      default:
        return null;
    }
  }

  self.PaperEnrich = { enrich };
})();
