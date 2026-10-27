/**
 * store.js — paper storage shared by the service worker, the new-tab page and
 * the popup.
 *
 * Layout: one chrome.storage.local key per paper, `p:<canonicalId>`. The
 * library used to live in a single `papers` object, so changing one field
 * rewrote the whole ~1 MB value; migrate() splits that object once.
 *
 * Each context keeps an in-memory copy, filled on first use and kept current
 * from storage.onChanged, so reads never go back to storage. Cached objects
 * are shared: read them, but change papers through put / update / edit.
 */

(function () {
  const PREFIX = 'p:';
  const LEGACY_KEY = 'papers';

  let cache = null; // Map canonicalId → paper
  let loading = null;
  const pending = new Map(); // changes that arrive while the cache is loading
  const listeners = new Set();

  // Split the legacy single-object library into per-paper keys. Runs under a
  // lock so the service worker and an open page can't migrate concurrently.
  async function migrate() {
    const legacy = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY];
    if (!legacy) return;
    const out = {};
    for (const [id, p] of Object.entries(legacy)) {
      if (p && typeof p === 'object' && id) out[PREFIX + id] = { ...p, id };
    }
    await chrome.storage.local.set(out);
    await chrome.storage.local.remove(LEGACY_KEY);
  }

  async function paperKeys() {
    const keys = chrome.storage.local.getKeys
      ? await chrome.storage.local.getKeys()
      : Object.keys(await chrome.storage.local.get(null));
    return keys.filter(k => k.startsWith(PREFIX));
  }

  function load() {
    if (cache) return Promise.resolve(cache);
    if (!loading) {
      loading = (async () => {
        await navigator.locks.request('paperclip-store-migrate', migrate);
        const keys = await paperKeys();
        const got = keys.length ? await chrome.storage.local.get(keys) : {};
        const m = new Map();
        for (const [k, p] of Object.entries(got)) m.set(k.slice(PREFIX.length), p);
        for (const [id, p] of pending) {
          if (p === undefined) m.delete(id);
          else m.set(id, p);
        }
        pending.clear();
        cache = m;
        return m;
      })();
    }
    return loading;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const ids = [];
    for (const [k, c] of Object.entries(changes)) {
      if (!k.startsWith(PREFIX)) continue;
      const id = k.slice(PREFIX.length);
      ids.push(id);
      if (!cache) {
        pending.set(id, c.newValue);
      } else if (c.newValue === undefined) {
        cache.delete(id);
      } else {
        cache.set(id, c.newValue);
      }
    }
    if (ids.length && cache) {
      for (const fn of listeners) {
        try { fn(ids); } catch (err) { console.warn('[paperclip] store listener', err); }
      }
    }
  });

  async function all() {
    return load();
  }

  async function get(id) {
    return (await load()).get(id);
  }

  /**
   * The entry stored under this canonical ID, or the entry it was merged
   * into (its `aliases` list the ID). Without the alias check, every backfill
   * after a merge would re-create the duplicate.
   */
  async function findByIdOrAlias(id) {
    const m = await load();
    if (m.has(id)) return m.get(id);
    for (const p of m.values()) {
      if (Array.isArray(p.aliases) && p.aliases.includes(id)) return p;
    }
    return null;
  }

  async function putMany(papers) {
    const m = await load();
    const out = {};
    for (const p of papers) {
      if (!p || !p.id) continue;
      out[PREFIX + p.id] = p;
      m.set(p.id, p);
    }
    if (Object.keys(out).length) await chrome.storage.local.set(out);
  }

  async function put(paper) {
    return putMany([paper]);
  }

  async function remove(ids) {
    const m = await load();
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) m.delete(id);
    if (list.length) await chrome.storage.local.remove(list.map(id => PREFIX + id));
  }

  /** Apply fn to a copy of one paper and store it. Returns the stored copy. */
  async function update(id, fn) {
    const cur = await get(id);
    if (!cur) return null;
    const next = structuredClone(cur);
    if ((await fn(next)) === false) return cur;
    await put(next);
    return next;
  }

  /**
   * Whole-library edit for merges, imports and cleanups: fn gets a deep copy
   * keyed by ID and may add, change or delete entries. Only the entries that
   * differ from the snapshot are written, so concurrent edits to other papers
   * survive.
   */
  async function edit(fn) {
    const m = await load();
    const papers = {};
    const before = new Map();
    for (const [id, p] of m) {
      papers[id] = structuredClone(p);
      before.set(id, JSON.stringify(p));
    }
    const result = await fn(papers);
    const changed = [];
    for (const [id, p] of Object.entries(papers)) {
      if (!p) continue;
      if (p.id !== id) p.id = id;
      if (before.get(id) !== JSON.stringify(p)) changed.push(p);
    }
    const removed = [...before.keys()].filter(id => !papers[id]);
    if (removed.length) await remove(removed);
    if (changed.length) await putMany(changed);
    return result;
  }

  /** Plain { id: paper } object of the cached library (read-only). */
  async function toObject() {
    return Object.fromEntries(await load());
  }

  /** Subscribe to paper changes from any context; fn receives changed IDs. */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function isPaperKey(k) {
    return typeof k === 'string' && k.startsWith(PREFIX);
  }

  self.PaperStore = { all, get, findByIdOrAlias, put, putMany, remove, update, edit, toObject, onChange, isPaperKey };
})();
