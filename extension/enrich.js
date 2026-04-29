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

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  async function enrich(paper) {
    if (!paper) return null;
    switch (paper.source) {
      case 'arxiv':
        return await enrichArxiv(paper);
      default:
        return null; // other sources arrive in a later commit
    }
  }

  self.PaperEnrich = { enrich };
})();
