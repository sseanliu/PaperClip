/**
 * translate.js — select text in the paper reader and its Simplified Chinese
 * translation streams into a card under the selection, from DeepSeek on
 * DeepInfra (the same model and approach as the XReader extension).
 *
 * A sentence or longer selection is translated. A word or short phrase (up
 * to six words) gets its Chinese as meant in this paper plus a short note,
 * with the surrounding page text sent as context. The card is display-only
 * and lives as long as the selection. The DeepInfra API key is entered in
 * Settings and kept in chrome.storage.local (never exported or synced).
 */
(function () {
  const ENDPOINT = 'https://api.deepinfra.com/v1/openai/chat/completions';
  const MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731';
  const KEY_STORAGE = 'deepinfraKey';
  const MAX_CHARS = 4000; // longer selections are not sent
  const SHORT_WORDS = 6;
  const CONTEXT_CHARS = 1500; // page text kept on each side of a short selection
  const TIMEOUT_MS = 30 * 1000;

  const TRANSLATE_PROMPT =
    'Translate the user\'s text, taken from an English research paper, into natural Simplified ' +
    'Chinese. Keep names, model names, math, code and citations such as [12] as they are. ' +
    'Output only the translation, nothing else.';
  const EXPLAIN_PROMPT =
    '用户在读一篇英文论文时选中了一个词或短语。请用简体中文回答：第一行只写它在这里的中文译法；' +
    '第二行用一两句话说明它在这篇文章里具体指什么，如果和常见意思不同，点出区别。' +
    '不要复述或翻译整段原文，不要用 Markdown。';

  const HAN = /\p{Script=Han}/u;
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });

  let apiKey = '';
  chrome.storage.local.get(KEY_STORAGE).then((s) => { apiKey = s[KEY_STORAGE] || ''; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY_STORAGE]) apiKey = changes[KEY_STORAGE].newValue || '';
  });

  const cache = new Map(); // prompt kind + text (+ context) -> finished answer
  let card = null;
  let shown = null; // { text, range, controller }

  // ---- Selection -------------------------------------------------------------------

  /** Selected text joins the PDF's lines; a word split by a line-end hyphen is rejoined. */
  function normalize(text) {
    return text
      .replace(/(\p{Ll})-\s*\n\s*(\p{Ll})/gu, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The current selection inside the reader's pages, or null. */
  function readerSelection() {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest('#lectorRoot .lector-pages')) return null;
    const text = normalize(sel.toString());
    if (!text || text.length > MAX_CHARS || !/\p{L}/u.test(text)) return null;
    // Already Chinese: nothing to translate.
    if (HAN.test(text) && !/[A-Za-z]/.test(text)) return null;
    return { text, range: range.cloneRange(), layer: el.closest('.textLayer') };
  }

  function isShort(text) {
    const words = Array.from(segmenter.segment(text)).filter((w) => w.isWordLike).length;
    return words > 0 && words <= SHORT_WORDS;
  }

  /** The page's text around a short selection, for the meaning in context. */
  function contextFor(selection) {
    const layer = selection.layer;
    if (!layer) return '';
    const page = normalize(layer.innerText || '');
    const at = page.indexOf(selection.text);
    if (at < 0) return page.slice(0, CONTEXT_CHARS * 2);
    return page.slice(Math.max(0, at - CONTEXT_CHARS), at + selection.text.length + CONTEXT_CHARS);
  }

  // ---- Request ---------------------------------------------------------------------

  /** Streams the completion, calling onText with the text so far. */
  async function stream(messages, signal, onText) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 4000, stream: true, messages }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${response.status} ${detail.slice(0, 120) || response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let out = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content;
        if (delta) {
          out += delta;
          onText(out);
        }
      }
    }
    return out.trim();
  }

  // ---- Card ------------------------------------------------------------------------

  function rectsOf(range) {
    return Array.from(range.getClientRects()).filter((r) => r.width && r.height);
  }

  /** Under the selection, or above it when there's no room below. */
  function place() {
    if (!shown || !card) return;
    const rects = rectsOf(shown.range);
    if (!rects.length) {
      hide();
      return;
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    const width = Math.min(480, innerWidth - 16);
    card.style.maxWidth = `${width}px`;
    card.style.left = `${Math.max(8, Math.min(first.left, innerWidth - width - 8))}px`;
    const height = card.offsetHeight;
    const below = last.bottom + 8;
    card.style.top = `${below + height < innerHeight - 8 ? below : Math.max(8, first.top - height - 8)}px`;
  }

  function setText(text, state = '') {
    card.textContent = text;
    card.dataset.state = state;
    place();
  }

  function show(selection) {
    if (!card) {
      card = document.createElement('div');
      card.className = 'translate-card';
      card.lang = 'zh-CN';
      document.body.appendChild(card);
    }
    if (shown && shown.controller) shown.controller.abort();
    shown = { text: selection.text, range: selection.range, controller: null };
    card.hidden = false;

    if (!apiKey) {
      setText('Add a DeepInfra API key in Settings (gear, top right) to translate selections.', 'note');
      return;
    }
    const short = isShort(selection.text);
    const context = short ? contextFor(selection) : '';
    const cacheKey = short ? `explain\u0000${selection.text}\u0000${context}` : `translate\u0000${selection.text}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      setText(hit);
      return;
    }
    const messages = short
      ? [{ role: 'system', content: EXPLAIN_PROMPT }, { role: 'user', content: `选中：${selection.text}\n\n上下文：${context}` }]
      : [{ role: 'system', content: TRANSLATE_PROMPT }, { role: 'user', content: selection.text }];
    const controller = new AbortController();
    const mine = shown;
    mine.controller = controller;
    setText('翻译中…', 'pending');
    stream(messages, controller.signal, (text) => {
      if (shown === mine) setText(text);
    })
      .then((text) => {
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, text);
        if (shown === mine) setText(text);
      })
      .catch((err) => {
        if (controller.signal.aborted || shown !== mine) return;
        setText(`Translation failed: ${err && err.message ? err.message : err}`, 'note');
      });
  }

  function hide() {
    if (shown && shown.controller) shown.controller.abort();
    shown = null;
    if (card) card.hidden = true;
  }

  // ---- Triggers --------------------------------------------------------------------

  // A selection made with the mouse: a drag, or a double/triple click.
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const selection = readerSelection();
      if (!selection || (shown && shown.text === selection.text)) return;
      show(selection);
    }, 0);
  });

  // The card lives as long as its selection.
  document.addEventListener('selectionchange', () => {
    if (!shown) return;
    const selection = readerSelection();
    if (!selection || selection.text !== shown.text) hide();
  });

  // Esc first dismisses the card (and its selection), not the reader.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shown) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    getSelection().removeAllRanges();
    hide();
  }, true);

  // The pages scroll inside the reader; follow the selection.
  document.addEventListener('scroll', place, { passive: true, capture: true });
  addEventListener('resize', place, { passive: true });
})();
