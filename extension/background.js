/**
 * background.js — Service Worker
 *
 * Two responsibilities:
 *   1. Toolbar badge: shows count of open real-web tabs, color-coded by load.
 *   2. Paper auto-capture: any paper URL visited gets persisted through
 *      PaperStore (store.js) permanently, with metadata enrichment kicked
 *      off in the background.
 */

// Pull in the URL classifier and metadata fetcher.
importScripts('papers.js', 'enrich.js', 'store.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

// Always clear the badge — we don't surface tab counts on the toolbar icon.
async function updateBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {}
}

// ─── Paper auto-capture ───────────────────────────────────────────────────────

const SOURCE_LABELS = {
  arxiv: 'arXiv',
  openreview: 'OpenReview',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  acm: 'ACM',
  ieee: 'IEEE',
  springer: 'Springer',
  nature: 'Nature',
  science: 'Science',
  nips: 'NeurIPS',
  mlr: 'PMLR',
  acl: 'ACL',
  cvf: 'CVF',
  semanticscholar: 'Semantic Scholar',
  pdf: 'PDF',
};

/**
 * Heuristic: does this string look like a URL or filename, not a real paper
 * title? Chrome's PDF viewer often sets tab.title to the URL with no scheme
 * (e.g. "arxiv.org/pdf/2604.22615"), and we don't want that as a "title".
 */
function looksLikeUrlOrFilename(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  // host/path with no spaces (real titles always have spaces)
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(t) && !/\s/.test(t)) return true;
  // bare PDF filename
  if (/^[\w.-]+\.pdf$/i.test(t)) return true;
  return false;
}

/**
 * Interstitial / error pages (Cloudflare challenges, rate-limit walls) whose
 * tab title would otherwise be stored as the paper's "title".
 */
function looksLikeErrorPage(s) {
  const t = (s || '').trim();
  if (!t) return false;
  if (/\b(just a moment|attention required|access denied|temporarily unavailable|checking your browser|verify you are human|page not found|security check|rate limit)\b/i.test(t)) return true;
  if (/^(400|401|403|404|408|429|500|502|503)\b/.test(t)) return true;
  return false;
}

/**
 * Fallback title cleanup for when enrichment hasn't run yet. Trims trailing
 * site-name garbage like " - arXiv" or " | OpenReview", and rejects titles
 * that are just the URL or an interstitial/error page.
 */
function fallbackTitle(rawTitle, cls) {
  const cleaned = (rawTitle || '')
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && !looksLikeUrlOrFilename(cleaned) && !looksLikeErrorPage(cleaned)) return cleaned;
  // Build a friendly placeholder from the classification, if available
  if (cls && cls.sourceId) {
    const label = SOURCE_LABELS[cls.source] || cls.source;
    return `${label}:${cls.sourceId}`;
  }
  return '';
}

// Per-tab dedup: tabId → canonicalId of the last paper we logged on that tab.
// Used so onUpdated firing multiple times during one navigation only counts
// a single visit.
const lastCapturedByTab = new Map();

/**
 * Upsert a paper into storage.
 *
 * mode:
 *   'visit'    — real navigation. Bump visitCount + lastSeenAt if the tab's
 *                paper changed; otherwise just refresh title if missing.
 *   'discover' — found via tab scan / backfill. Add only if absent.
 *                Doesn't bump visitCount or lastSeenAt for existing entries.
 */
async function capturePaper(tab, mode = 'visit') {
  if (!tab || !tab.url) return;
  const cls = classifyPaper(tab.url);
  if (!cls) {
    if (tab.id != null) lastCapturedByTab.delete(tab.id);
    return;
  }

  const now = new Date().toISOString();
  const cached = await PaperStore.findByIdOrAlias(cls.canonicalId);
  const existing = cached ? structuredClone(cached) : null;
  let created = null;

  let didMutate = false;

  if (existing) {
    if (mode === 'visit') {
      const tabPrev = tab.id != null ? lastCapturedByTab.get(tab.id) : null;
      const isFreshVisit = tabPrev !== cls.canonicalId;
      if (isFreshVisit) {
        existing.lastSeenAt = now;
        existing.visitCount = (existing.visitCount || 0) + 1;
        didMutate = true;
      }
      if (tab.url && existing.url !== tab.url) {
        existing.url = tab.url;
        didMutate = true;
      }
      const t = fallbackTitle(tab.title || '', cls);
      if (!existing.title && t) {
        existing.title = t;
        didMutate = true;
      }
    }
    // mode === 'discover' on an existing entry: nothing to do.
  } else {
    created = {
      id: cls.canonicalId,
      url: tab.url,
      source: cls.source,
      sourceId: cls.sourceId,
      doi: cls.doi || null,
      title: fallbackTitle(tab.title || '', cls),
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1,
      readStatus: 'unread',
      enrichmentStatus: 'pending',
      enrichedAt: null
    };
    didMutate = true;
  }

  const isFreshVisit = mode === 'visit' && tab.id != null && lastCapturedByTab.get(tab.id) !== cls.canonicalId;
  if (tab.id != null) lastCapturedByTab.set(tab.id, cls.canonicalId);
  if (!didMutate) return;

  const paper = existing || created;
  await PaperStore.put(paper);

  // Kick off metadata enrichment for new entries. A failed entry retries on
  // its backoff schedule, or right away when the user opens the paper again.
  // Use the stored entry's id, which may differ from cls.canonicalId when this
  // URL points to a merged record under a different primary key.
  if (needsEnrichment(paper) || (isFreshVisit && paper.enrichmentStatus === 'failed')) {
    scheduleEnrichment(paper.id, { force: isFreshVisit });
  }
}

// ─── Auto-attach related tabs ─────────────────────────────────────────────────
//
// When a tab loads that ISN'T itself a paper URL but mentions a paper we
// already have (via arXiv ID or DOI in the URL or page title), attach the
// tab to that paper as a linked URL. This is silent and zero-confirmation —
// arXiv IDs and DOIs are unique enough that false positives are negligible.
// Lower-confidence matches (slug / title overlap) are surfaced in the popup
// as "Suggested" entries instead.

// Cheap pre-check: a page can only match by arXiv ID or DOI if its URL or
// title contains something shaped like one. Most tab updates (mail, chat,
// video) fail this and never touch the library.
const PAPER_ID_HINT = /\b\d{4}\.\d{4,5}\b|\/\d{7}\b|\b10\.\d{4,9}\//;

function findVeryHighConfidenceMatch(papers, tab) {
  if (!tab || !tab.url) return null;
  const url = (tab.url || '').toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const haystack = `${url} ${title}`;

  for (const p of papers.values()) {
    if (p.source === 'arxiv' && p.sourceId) {
      const id = p.sourceId.toLowerCase();
      if (id.length >= 7 && haystack.includes(id)) {
        return { paper: p, why: 'arxiv-id' };
      }
    }
    if (p.doi) {
      const d = String(p.doi).toLowerCase();
      // DOIs are noisy substrings; require the slash form so e.g. '10.1109/'
      // doesn't accidentally match dates or product codes.
      if (d.includes('/') && haystack.includes(d)) {
        return { paper: p, why: 'doi' };
      }
    }
  }
  return null;
}

async function maybeAutoAttachToRelated(tab) {
  if (!tab || !tab.url || !tab.title) return;
  if (!/^https?:/i.test(tab.url)) return;
  // Skip tabs that ARE a paper URL — those are auto-captured as the paper
  // itself, not as an attachment to a different paper.
  if (classifyPaper(tab.url)) return;
  if (!PAPER_ID_HINT.test(`${tab.url} ${tab.title}`)) return;

  const match = findVeryHighConfidenceMatch(await PaperStore.all(), tab);
  if (!match) return;

  await PaperStore.update(match.paper.id, (paper) => {
    paper.attachments = Array.isArray(paper.attachments) ? paper.attachments : [];
    if (paper.attachments.some(a => a && a.url === tab.url)) return false; // already linked
    paper.attachments.push({
      url: tab.url,
      title: tab.title,
      addedAt: new Date().toISOString(),
      autoAttached: true,
      matchReason: match.why,
    });
    if (!paper.starred) paper.starred = true;
  });
}

/**
 * Scan every currently-open tab and add any papers we don't already have.
 * Used on extension install, browser startup, and on every new-tab page load.
 */
async function backfillExistingTabs() {
  let added = 0;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url) continue;
      const cls = classifyPaper(t.url);
      if (cls) {
        // Skip if this canonical ID already exists OR is in another paper's
        // aliases (merged duplicate). Otherwise we'd recreate the dupe each
        // time the new-tab page opens.
        if (!(await PaperStore.findByIdOrAlias(cls.canonicalId))) {
          await capturePaper(t, 'discover');
          added += 1;
        }
      } else {
        // Non-paper tab — but it might mention a paper we have (via arXiv
        // ID or DOI). Attach it as a related URL if so.
        await maybeAutoAttachToRelated(t);
      }
    }
  } catch (err) {
    console.warn('[paperclip] backfill error', err);
  }
  return added;
}

// ─── Metadata enrichment queue ────────────────────────────────────────────────
//
// All enrichment runs serially through a single Promise chain with a small
// throttle delay between requests. arXiv and Semantic Scholar both rate-limit
// hard — firing 30+ concurrent requests gets most of them rejected. One per
// second is well within everyone's budget.

const ENRICH_THROTTLE_MS = 900;

// Bumped whenever the enrichment schema or behavior changes meaningfully.
// retryStuckEnrichments() re-runs anything below the current version.
const ENRICHMENT_VERSION = 2;

// Failed lookups back off instead of retrying on every service-worker wake:
// attempt N waits ENRICH_RETRY_DELAYS_MS[N-1], and after the last step the
// entry stays 'failed' until the user opens the paper again. Some sources
// fail permanently (OpenReview answers 403 challenge pages to API calls), and
// every retry rewrites the stored entry.
const ENRICH_RETRY_DELAYS_MS = [1, 6, 24, 72].map(h => h * 3600 * 1000);

function needsEnrichment(p, now = Date.now()) {
  const isCurrent = (p.enrichmentVersion || 0) >= ENRICHMENT_VERSION;
  if (p.enrichmentStatus === 'pending') return true;
  if (p.enrichmentStatus === 'failed') {
    // Entries that failed before backoff existed have no schedule yet.
    if (p.nextEnrichAt === undefined) return true;
    return p.nextEnrichAt !== null && now >= p.nextEnrichAt;
  }
  return !isCurrent;
}

const enrichQueued = new Set();
let enrichChain = Promise.resolve();

function scheduleEnrichment(canonicalId, { force = false } = {}) {
  if (enrichQueued.has(canonicalId)) return;
  enrichQueued.add(canonicalId);
  enrichChain = enrichChain.then(async () => {
    try {
      await runEnrichmentOnce(canonicalId, force);
    } catch (err) {
      console.warn('[paperclip] enrich queue error', canonicalId, err);
    } finally {
      enrichQueued.delete(canonicalId);
    }
    await new Promise(r => setTimeout(r, ENRICH_THROTTLE_MS));
  });
}

async function runEnrichmentOnce(canonicalId, force = false) {
  const paper = await PaperStore.get(canonicalId);
  if (!paper) return;
  if (!needsEnrichment(paper) && !(force && paper.enrichmentStatus === 'failed')) return;

  let patches = null;
  try {
    patches = await PaperEnrich.enrich(paper);
  } catch (err) {
    console.warn('[paperclip] enrich error', canonicalId, err);
    await PaperStore.update(canonicalId, (p) => {
      const attempts = (p.enrichAttempts || 0) + 1;
      p.enrichmentStatus = 'failed';
      p.enrichAttempts = attempts;
      p.nextEnrichAt = attempts <= ENRICH_RETRY_DELAYS_MS.length
        ? Date.now() + ENRICH_RETRY_DELAYS_MS[attempts - 1]
        : null;
      p.enrichedAt = new Date().toISOString();
      p.enrichmentVersion = ENRICHMENT_VERSION;
    });
    return;
  }

  if (patches == null) {
    await PaperStore.update(canonicalId, (p) => {
      delete p.enrichAttempts;
      delete p.nextEnrichAt;
      p.enrichmentStatus = 'unsupported';
      p.enrichedAt = new Date().toISOString();
      p.enrichmentVersion = ENRICHMENT_VERSION;
    });
    return;
  }

  await PaperStore.edit((papers) => {
    const p = papers[canonicalId];
    if (!p) return;
    delete p.enrichAttempts;
    delete p.nextEnrichAt;
    if (patches.title) p.title = patches.title;
    if (Array.isArray(patches.authors) && patches.authors.length) p.authors = patches.authors;
    if (patches.year != null) p.year = patches.year;
    if (patches.venue) p.venue = patches.venue;
    if (patches.abstract) p.abstract = patches.abstract;
    if (patches.externalIds) p.externalIds = patches.externalIds;
    p.enrichmentStatus = 'ok';
    p.enrichedAt = new Date().toISOString();
    p.enrichmentVersion = ENRICHMENT_VERSION;

    // Now that we know this paper's external IDs (DOI / ArXiv / etc.), check
    // whether any other entry in the library is the same paper under a
    // different canonical ID — same paper visited via arxiv URL and via the
    // CHI portal, for example. If so, merge them.
    dedupeAcrossExternalIds(papers, canonicalId);
  });
}

/**
 * Find any papers that need enrichment and re-queue them. Includes:
 *   - 'pending' status (never finished)
 *   - 'failed' status whose backoff delay has passed
 *   - 'ok' but enrichmentVersion is below the current code (schema upgrade)
 * Called after backfill, on browser startup, and on extension install.
 */
async function retryStuckEnrichments() {
  const papers = await PaperStore.all();
  const now = Date.now();
  for (const p of papers.values()) {
    if (needsEnrichment(p, now)) scheduleEnrichment(p.id);
  }
}

// ─── Cross-source duplicate detection ─────────────────────────────────────────
//
// Same paper opened from multiple sources (arxiv pre-print + ACM camera-ready)
// gets stored under different canonical IDs. After enrichment fills in the
// externalIds field via Semantic Scholar, we can detect these duplicates by
// matching shared DOIs / arXiv IDs and merge them.

function externalIdSet(paper) {
  const ids = new Set();
  if (typeof paper.id === 'string') {
    if (paper.id.startsWith('arxiv:')) {
      ids.add(`arxiv:${paper.id.slice(6).toLowerCase().replace(/v\d+$/, '')}`);
    } else if (paper.id.startsWith('doi:')) {
      ids.add(`doi:${paper.id.slice(4).toLowerCase()}`);
    }
  }
  if (paper.doi) ids.add(`doi:${String(paper.doi).toLowerCase()}`);
  const ext = paper.externalIds || {};
  if (ext.DOI) ids.add(`doi:${String(ext.DOI).toLowerCase()}`);
  if (ext.ArXiv) ids.add(`arxiv:${String(ext.ArXiv).toLowerCase().replace(/v\d+$/, '')}`);
  return ids;
}

function papersAreDuplicates(a, b) {
  if (a.id === b.id) return false;
  const aIds = externalIdSet(a);
  if (aIds.size === 0) return false;
  for (const id of externalIdSet(b)) {
    if (aIds.has(id)) return true;
  }
  return false;
}

function mergePapers(primary, secondary) {
  if (!primary.firstSeenAt || (secondary.firstSeenAt && secondary.firstSeenAt < primary.firstSeenAt)) {
    primary.firstSeenAt = secondary.firstSeenAt;
  }
  if (!primary.lastSeenAt || (secondary.lastSeenAt && secondary.lastSeenAt > primary.lastSeenAt)) {
    primary.lastSeenAt = secondary.lastSeenAt;
  }
  primary.visitCount = (primary.visitCount || 0) + (secondary.visitCount || 0);

  if (!primary.title && secondary.title) primary.title = secondary.title;
  if (!primary.year && secondary.year) primary.year = secondary.year;
  if (!primary.venue && secondary.venue) primary.venue = secondary.venue;
  if (!primary.abstract && secondary.abstract) primary.abstract = secondary.abstract;
  if ((!primary.authors || primary.authors.length === 0) && Array.isArray(secondary.authors) && secondary.authors.length) {
    primary.authors = secondary.authors;
  }
  if (!primary.doi && secondary.doi) primary.doi = secondary.doi;

  // externalIds union, primary wins on conflicts
  primary.externalIds = { ...(secondary.externalIds || {}), ...(primary.externalIds || {}) };

  // Track aliases so we know which canonical IDs got folded in here.
  const aliases = new Set(primary.aliases || []);
  aliases.add(secondary.id);
  if (Array.isArray(secondary.aliases)) {
    for (const a of secondary.aliases) aliases.add(a);
  }
  primary.aliases = [...aliases];

  if (secondary.readStatus === 'read') primary.readStatus = 'read';
}

function dedupeAcrossExternalIds(papers, paperId) {
  const target = papers[paperId];
  if (!target) return false;

  const matches = [];
  for (const p of Object.values(papers)) {
    if (p.id === paperId) continue;
    if (papersAreDuplicates(target, p)) matches.push(p);
  }
  if (matches.length === 0) return false;

  // Pick primary as the entry with the earliest firstSeenAt — keeps the
  // user's library order stable.
  const all = [target, ...matches];
  all.sort((a, b) => (a.firstSeenAt || '').localeCompare(b.firstSeenAt || ''));
  const primary = all[0];

  for (const s of all.slice(1)) {
    mergePapers(primary, s);
    delete papers[s.id];
  }
  return true;
}

/**
 * Re-classify stored generic-PDF entries whose URL the classifier now
 * understands (e.g. a newly added site pattern like CVF Open Access). Moves
 * the entry to its proper canonical ID — merging if that paper already
 * exists — and resets enrichment so real metadata gets fetched.
 */
function findInObject(papers, canonicalId) {
  if (papers[canonicalId]) return papers[canonicalId];
  for (const p of Object.values(papers)) {
    if (Array.isArray(p.aliases) && p.aliases.includes(canonicalId)) return p;
  }
  return null;
}

async function reclassifyGenericPdfs() {
  await PaperStore.edit((papers) => {
    for (const p of Object.values(papers)) {
      if (p.source !== 'pdf' || !p.url) continue;
      const cls = classifyPaper(p.url);
      if (!cls || cls.source === 'pdf' || cls.canonicalId === p.id) continue;

      delete papers[p.id];
      const existing = findInObject(papers, cls.canonicalId);
      if (existing) {
        mergePapers(existing, p);
      } else {
        const aliases = new Set(p.aliases || []);
        aliases.add(p.id);
        p.aliases = [...aliases];
        p.id = cls.canonicalId;
        p.source = cls.source;
        p.sourceId = cls.sourceId;
        if (cls.doi && !p.doi) p.doi = cls.doi;
        p.enrichmentStatus = 'pending';
        papers[cls.canonicalId] = p;
      }
    }
  });
}

/**
 * Clear stored titles that are really interstitial/error pages captured
 * before looksLikeErrorPage existed, so the next visit / enrichment can
 * fill in a real one.
 */
async function cleanupJunkTitles() {
  await PaperStore.edit((papers) => {
    for (const p of Object.values(papers)) {
      if (p.title && looksLikeErrorPage(p.title)) p.title = null;
      // Entries the classifier would now reject (e.g. "arxiv:TODO" from a
      // placeholder link) can never be enriched; drop them.
      if (p.source === 'arxiv' && !isValidArxivId(p.sourceId)) delete papers[p.id];
    }
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  await reclassifyGenericPdfs();
  await cleanupJunkTitles();
  retryStuckEnrichments();
});

chrome.runtime.onStartup.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  await reclassifyGenericPdfs();
  await cleanupJunkTitles();
  retryStuckEnrichments();
});

chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  if (tab && tab.url) {
    capturePaper(tab, 'visit');
    maybeAutoAttachToRelated(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateBadge();
  lastCapturedByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();
  // Capture on URL change (eager — don't wait for load to finish), on load
  // complete (so we get the final title), and on title-only updates (Chrome
  // sometimes sets the title after status='complete'). capturePaper dedupes
  // per-tab so we don't overcount visits when multiple events fire.
  if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
    if (tab && tab.url) {
      capturePaper(tab, 'visit');
      maybeAutoAttachToRelated(tab);
    }
  }
});

// Message handler: the new-tab page asks us to re-scan tabs whenever it
// loads, as a safety net for anything we missed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'paperclip:backfill') {
    (async () => {
      const count = await backfillExistingTabs();
      retryStuckEnrichments();
      sendResponse({ ok: true, count });
    })();
    return true; // keep channel open for async response
  }
});

// Initial run
updateBadge();
backfillExistingTabs().then(() => retryStuckEnrichments());

// ---------------------------------------------------------------------------
// Obsidian bridge: mirror the library to the local vault via native messaging.
// Debounced through chrome.alarms (MV3 service workers outlive setTimeout but
// not vice versa). Fails silent when the host isn't installed — capture always
// comes first.

const VAULT_SYNC_HOST = 'com.xiaoan.paperclip';
const VAULT_SYNC_ALARM = 'vault-sync';
const VAULT_PULL_ALARM = 'vault-pull';
const VAULT_SYNC_DEBOUNCE_MIN = 0.5;
// Syncs not caused by a local change (new-tab opens, worker startup) only
// pull vault-side edits, so they run at most this often. Each sync sends the
// whole library to a freshly spawned host process.
const VAULT_PULL_INTERVAL_MS = 10 * 60 * 1000;

function scheduleVaultSync(delayMinutes = VAULT_SYNC_DEBOUNCE_MIN) {
  chrome.alarms.create(VAULT_SYNC_ALARM, { delayInMinutes: delayMinutes });
}

async function syncToVault({ ifStale = false } = {}) {
  try {
    if (ifStale) {
      const { vaultSyncedAt = 0 } = await chrome.storage.session.get('vaultSyncedAt');
      if (Date.now() - vaultSyncedAt < VAULT_PULL_INTERVAL_MS) return;
    }
    await chrome.storage.session.set({ vaultSyncedAt: Date.now() });
    const papers = await PaperStore.toObject();
    const { tags = {} } = await chrome.storage.local.get('tags');
    const library = {
      schema: 'paperclip.library.v2',
      exportedAt: new Date().toISOString(),
      paperCount: Object.keys(papers).length,
      tagCount: Object.keys(tags).length,
      papers,
      tags,
    };
    chrome.runtime.sendNativeMessage(VAULT_SYNC_HOST, { type: 'sync', library }, (reply) => {
      if (chrome.runtime.lastError) return; // host not installed on this machine
      if (reply && reply.ok) applyVaultReply(reply);
    });
  } catch (e) {
    // Never let sync problems interfere with capture.
  }
}

// The vault is a peer, not a mirror: edits made there (agent retags, inbox
// checkbox verbs) come back as vaultDeltas. Applying them re-fires onChanged
// and one more sync round, after which the ledger base matches and the deltas
// are empty — the cycle terminates by convergence, not by suppression.
async function applyVaultReply(reply) {
  if (reply.membership) {
    // Usually unchanged between syncs; skip the write when it is.
    const { corpusMembership } = await chrome.storage.local.get('corpusMembership');
    if (JSON.stringify(corpusMembership) !== JSON.stringify(reply.membership)) {
      await chrome.storage.local.set({ corpusMembership: reply.membership });
    }
  }
  const deltas = reply.vaultDeltas || {};
  const paperEdits = deltas.papers || {};
  const newTags = deltas.tags || {};
  const removeTags = deltas.removeTags || [];
  if (!Object.keys(paperEdits).length && !Object.keys(newTags).length && !removeTags.length) return;
  const { tags = {} } = await chrome.storage.local.get('tags');
  let tagsTouched = false;
  for (const [tid, tag] of Object.entries(newTags)) {
    if (!tags[tid]) {
      tags[tid] = tag;
      tagsTouched = true;
    }
  }
  for (const tid of removeTags) {
    if (tags[tid]) {
      delete tags[tid];
      tagsTouched = true;
    }
  }
  await PaperStore.edit((papers) => {
    for (const [id, fields] of Object.entries(paperEdits)) {
      if (papers[id]) Object.assign(papers[id], fields);
    }
    for (const tid of removeTags) {
      for (const p of Object.values(papers)) {
        if (Array.isArray(p.tags) && p.tags.includes(tid)) {
          p.tags = p.tags.filter((t) => t !== tid);
        }
      }
    }
  });
  if (tagsTouched) await chrome.storage.local.set({ tags });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.tags || Object.keys(changes).some(PaperStore.isPaperKey)) scheduleVaultSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VAULT_SYNC_ALARM) syncToVault();
  if (alarm.name === VAULT_PULL_ALARM) syncToVault({ ifStale: true });
});

// New-tab opens already ping us for a backfill; ride the same signal to pull
// vault-side edits (the worker is awake, no alarm needed).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'paperclip:backfill') syncToVault({ ifStale: true });
});

// Catch anything missed while the browser was closed.
chrome.alarms.create(VAULT_PULL_ALARM, { delayInMinutes: 1 });
