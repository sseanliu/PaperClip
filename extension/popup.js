/**
 * popup.js — picker shown when the user clicks the toolbar icon.
 *
 * Saves the active tab's URL + title as a linked attachment under whichever
 * paper the user picks. Each paper can hold any number of attachments.
 */

(async function () {
  const PAPERS_KEY = 'papers';

  const currentEl = document.getElementById('popupCurrent');
  const searchEl = document.getElementById('popupSearch');
  const listEl = document.getElementById('popupList');
  const messageEl = document.getElementById('popupMessage');

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showMessage(text) {
    listEl.style.display = 'none';
    messageEl.style.display = 'block';
    messageEl.textContent = text;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.url) {
    showMessage('No active tab.');
    return;
  }

  const url = activeTab.url;
  const title = activeTab.title || activeTab.url;

  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('brave://')
  ) {
    currentEl.textContent = title;
    currentEl.title = url;
    showMessage("Can't save Chrome internal pages.");
    return;
  }

  currentEl.textContent = title;
  currentEl.title = url;

  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = Object.values(store[PAPERS_KEY] || {});
  papers.sort((a, b) => (b.firstSeenAt || '').localeCompare(a.firstSeenAt || ''));

  if (papers.length === 0) {
    showMessage('No papers in your library yet.');
    return;
  }

  function matches(p, q) {
    if (!q) return true;
    const hay = [
      p.title, (p.authors || []).join(' '), p.venue, p.year, p.url
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function alreadyAttached(p) {
    return Array.isArray(p.attachments) && p.attachments.some(a => a.url === url);
  }

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const filtered = papers.filter(p => matches(p, q));
    if (filtered.length === 0) {
      listEl.innerHTML = '';
      messageEl.style.display = 'block';
      messageEl.textContent = 'No matches.';
      return;
    }
    messageEl.style.display = 'none';
    listEl.style.display = 'block';
    listEl.innerHTML = filtered.map(p => {
      const authors = (p.authors || []).slice(0, 2).join(', ')
        + ((p.authors && p.authors.length > 2) ? ' et al.' : '');
      const meta = [authors, p.year, p.venue].filter(Boolean).join(' · ');
      const saved = alreadyAttached(p);
      return `
        <button class="popup-paper${saved ? ' is-saved' : ''}" data-id="${escape(p.id)}">
          <div class="popup-paper-title">${escape(p.title || p.id)}</div>
          <div class="popup-paper-meta">${saved ? 'Already saved' : escape(meta || '—')}</div>
        </button>
      `;
    }).join('');
  }

  render();
  searchEl.focus();

  searchEl.addEventListener('input', render);

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.popup-paper');
    if (!btn) return;
    const paperId = btn.dataset.id;

    const s = await chrome.storage.local.get(PAPERS_KEY);
    const ps = s[PAPERS_KEY] || {};
    const paper = ps[paperId];
    if (!paper) return;

    paper.attachments = paper.attachments || [];
    let mutated = false;
    if (!paper.attachments.some(a => a.url === url)) {
      paper.attachments.push({
        url,
        title,
        addedAt: new Date().toISOString(),
      });
      mutated = true;
    }
    // Linking a URL is a strong signal of interest — auto-star the paper if
    // it isn't starred yet.
    if (!paper.starred) {
      paper.starred = true;
      mutated = true;
    }
    if (mutated) {
      await chrome.storage.local.set({ [PAPERS_KEY]: ps });
    }

    btn.classList.add('is-saved');
    btn.querySelector('.popup-paper-meta').textContent = 'Saved';
    setTimeout(() => window.close(), 350);
  });
})();
