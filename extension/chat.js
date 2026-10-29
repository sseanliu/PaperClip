/**
 * chat.js — Option+Space in the reader opens a Claude Code session about the
 * open paper. native/claude_host.py runs it over native messaging: the
 * user's own `claude` CLI, login (subscription), settings and tools, with
 * the PDF in the session's working directory. Answers stream in here; tool
 * calls that need approval show Allow / Deny.
 *
 * Each paper has its own sessions, read from Claude Code's transcripts by the
 * host: opening the chat resumes the latest one and shows it so far, the
 * clock lists them all (switch to any and keep asking), "+" starts a new one.
 */
(function () {
  const HOST = 'com.xiaoan.paperclip.claude';
  const POSITION_KEY = 'paperclip-chat-position';
  // One-click starter shown on an empty conversation.
  const SUGGESTION = '这篇 paper 讲了什么？';
  const KEEP_VISIBLE_PX = 80; // a dragged window keeps this much on screen

  let win = null;
  let listEl = null;
  let inputEl = null;
  let sendBtn = null;
  let titleEl = null;
  let noticeEl = null;

  let port = null;
  let paper = null; // { id, title, pdfUrl } the session is about
  let ready = false;
  let busy = false;
  let pendingAsk = null; // { text, images } sent before the session was ready
  let attachments = []; // pasted/dropped images: { mediaType, data (base64), src (data URL) }
  let attachEl = null;
  let messages = []; // { role: 'user' | 'assistant', parts: [...] }
  let sessionId = null; // the session on screen, once the host knows it
  let historyEl = null;
  let renderQueued = false;

  // ---- Markdown (small, escape-first) ----------------------------------------------

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  // GitHub-style tables: a header row, a |---|:---:| separator, then rows.
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_SEPARATOR = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

  function cells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function tableHtml(lines) {
    const align = cells(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const row = (line, tag) => `<tr>${cells(line).map((c, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
    return `<div class="chat-table"><table><thead>${row(lines[0], 'th')}</thead>`
      + `<tbody>${lines.slice(2).map((l) => row(l, 'td')).join('')}</tbody></table></div>`;
  }

  /** A block's lines with any tables in it split out (text right above a table needs no blank line). */
  function withTables(lines) {
    for (let i = 0; i + 1 < lines.length; i++) {
      if (TABLE_ROW.test(lines[i]) && TABLE_SEPARATOR.test(lines[i + 1])) {
        let end = i + 2;
        while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
        return [
          i ? blockHtml(lines.slice(0, i)) : '',
          tableHtml(lines.slice(i, end)),
          end < lines.length ? withTables(lines.slice(end)) : '',
        ].join('');
      }
    }
    return blockHtml(lines);
  }

  function textBlocks(text) {
    return text.split(/\n{2,}/).map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      return lines.length ? withTables(lines) : '';
    }).join('');
  }

  function blockHtml(lines) {
    const heading = lines.length === 1 && lines[0].match(/^#{1,4}\s+(.*)$/);
    if (heading) return `<h4>${inline(heading[1])}</h4>`;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }

  // ---- Math (KaTeX, loaded with the chat window) ---------------------------------

  // $$..$$ and \[..\] are display math; $..$ and \(..\) inline. An inline $
  // must hug its content and not be followed by a digit, so "$5 and $10"
  // stays text. Unclosed delimiters (mid-stream) stay text until they close.
  const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/g;
  let katexLoading = null;

  function loadKatex() {
    if (window.katex || katexLoading) return;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/katex/katex.min.css';
    document.head.appendChild(css);
    katexLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'vendor/katex/katex.min.js';
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    }).then(() => { if (window.katex) renderAll(); });
  }

  function texHtml(tex, displayMode) {
    if (!window.katex) return esc(displayMode ? `$$${tex}$$` : `$${tex}$`);
    try {
      return window.katex.renderToString(tex.trim(), { displayMode, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
    } catch {
      return esc(tex);
    }
  }

  /**
   * Swaps math for placeholders (private-use characters the Markdown pass
   * leaves alone), so "<", "*" or "_" inside a formula never reach it.
   */
  function stashMath(text, stash) {
    return text.replace(MATH, (_, d1, d2, i1, i2) => {
      const display = d1 !== undefined || d2 !== undefined;
      stash.push(texHtml(d1 ?? d2 ?? i1 ?? i2, display));
      return `\uE000${stash.length - 1}\uE001`;
    });
  }

  function markdown(src) {
    // Odd pieces sit between ``` fences; a fence still streaming in shows as code.
    return src.split('```').map((piece, i) => {
      if (i % 2) return `<pre><code>${esc(piece.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
      const stash = [];
      return textBlocks(stashMath(piece, stash)).replace(/\uE000(\d+)\uE001/g, (_, n) => stash[n]);
    }).join('');
  }

  // ---- Window ----------------------------------------------------------------------

  function build() {
    win = document.createElement('div');
    win.className = 'chat-window';
    win.hidden = true;
    win.innerHTML = `
      <div class="chat-header">
        <div class="chat-heading">
          <span class="chat-label">Claude Code</span>
          <span class="chat-paper" id="chatPaper"></span>
        </div>
        <button class="chat-icon-btn" data-chat-action="history" title="Earlier chats about this paper" aria-label="Earlier chats">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        </button>
        <button class="chat-icon-btn" data-chat-action="new" title="New chat (Option+N)" aria-label="New chat">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <button class="chat-icon-btn" data-chat-action="close" title="Close (Esc)" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="chat-list" id="chatList"></div>
      <div class="chat-history" id="chatHistory" hidden></div>
      <div class="chat-notice" id="chatNotice" hidden></div>
      <div class="chat-attachments" id="chatAttachments" hidden></div>
      <div class="chat-compose">
        <textarea class="chat-input" id="chatInput" rows="1" placeholder="Ask about this paper…"></textarea>
        <button class="chat-send" data-chat-action="send" title="Send (Enter)">Send</button>
      </div>
    `;
    document.body.appendChild(win);
    listEl = win.querySelector('#chatList');
    inputEl = win.querySelector('#chatInput');
    sendBtn = win.querySelector('.chat-send');
    titleEl = win.querySelector('#chatPaper');
    noticeEl = win.querySelector('#chatNotice');
    historyEl = win.querySelector('#chatHistory');
    attachEl = win.querySelector('#chatAttachments');

    win.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-chat-action]');
      if (!btn) return;
      const action = btn.dataset.chatAction;
      if (action === 'close') hide();
      else if (action === 'new') newChat();
      else if (action === 'history') toggleHistory();
      else if (action === 'open-session') openSession(btn.dataset.sessionId);
      else if (action === 'send') (busy ? interrupt() : submit());
      else if (action === 'suggest' && !busy) submit(SUGGESTION);
      else if (action === 'allow' || action === 'deny') answerPermission(btn.dataset.requestId, action === 'allow');
      else if (action === 'remove-image') {
        attachments.splice(Number(btn.dataset.index), 1);
        renderAttachments();
        inputEl.focus();
      }
    });

    // Paste a screenshot into the input, or drop image files on the window.
    inputEl.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      // Keep any text that came along; a bare image shouldn't paste a file name.
      if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
      files.forEach(addImage);
    });
    win.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) e.preventDefault();
    });
    win.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      files.forEach(addImage);
      inputEl.focus();
    });
    inputEl.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a new line; Enter while composing (IME) is not a send.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!busy) submit();
      }
    });
    inputEl.addEventListener('input', autosize);

    // Drag the header to move the window; double-click it to re-center.
    const header = win.querySelector('.chat-header');
    header.addEventListener('pointerdown', startDrag);
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      win.classList.remove('is-placed');
      win.style.left = '';
      win.style.top = '';
      try { localStorage.removeItem(POSITION_KEY); } catch {}
    });
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      if (saved) placeAt(saved.left, saved.top);
    } catch {}
    addEventListener('resize', () => {
      if (win.classList.contains('is-placed')) placeAt(parseFloat(win.style.left), parseFloat(win.style.top));
    });
  }

  /** Moves the window so its top-left is at (left, top), keeping it reachable. */
  function placeAt(left, top) {
    const width = win.offsetWidth || 680;
    win.classList.add('is-placed');
    win.style.left = `${Math.round(Math.min(innerWidth - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - width, left)))}px`;
    win.style.top = `${Math.round(Math.min(innerHeight - 48, Math.max(0, top)))}px`;
  }

  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const header = e.currentTarget;
    const rect = win.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    header.setPointerCapture(e.pointerId);
    document.body.classList.add('chat-dragging');
    const move = (ev) => placeAt(ev.clientX - dx, ev.clientY - dy);
    const end = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', end);
      header.removeEventListener('pointercancel', end);
      document.body.classList.remove('chat-dragging');
      if (!win.classList.contains('is-placed')) return;
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ left: parseFloat(win.style.left), top: parseFloat(win.style.top) }));
      } catch {}
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
  }

  function notice(text) {
    noticeEl.textContent = text || '';
    noticeEl.hidden = !text;
  }

  function isShown() {
    return !!(win && !win.hidden);
  }

  function show() {
    const current = window.PaperViewer && window.PaperViewer.current();
    if (!current) return;
    if (!win) build();
    loadKatex();
    win.hidden = false;
    if (!paper || paper.id !== current.paper.id || !port) {
      connect({ id: current.paper.id, title: current.paper.title || current.paper.url || '', pdfUrl: current.pdfUrl });
    }
    inputEl.focus();
  }

  function hide() {
    if (!win) return;
    win.hidden = true;
    // Back to the paper, so arrows and space scroll it.
    const root = document.getElementById('lectorRoot');
    if (root) root.focus({ preventScroll: true });
  }

  // ---- Session ---------------------------------------------------------------------

  /**
   * Opens the host and starts a session for the paper: `sessionId` resumes
   * that one, `fresh` starts a new one, otherwise the latest is resumed. The
   * host sends the resumed session's messages. `reconnect` keeps what's on
   * screen (the bridge went away mid-conversation) and sends `ask` once ready.
   */
  function connect(next, { fresh = false, sessionId: wanted = null, reconnect = false, ask = null } = {}) {
    disconnect();
    paper = next;
    ready = false;
    pendingAsk = ask;
    closeHistory();
    if (!reconnect) {
      setBusy(false);
      messages = [];
      sessionId = null;
    }
    titleEl.textContent = paper.title;
    titleEl.title = paper.title;
    renderAll();
    notice('Starting Claude Code…');
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (err) {
      notice(`Could not start the Claude bridge: ${err.message}`);
      return;
    }
    const mine = port;
    port.onMessage.addListener((msg) => { if (port === mine) onHostMessage(msg); });
    port.onDisconnect.addListener(() => {
      if (port !== mine) return;
      const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
      port = null;
      ready = false;
      setBusy(false);
      if (err && /not found/i.test(err)) {
        notice('The Claude bridge is not installed: run native/install.sh in the PaperClip repo, then reopen.');
      } else if (err) {
        notice(`Claude bridge stopped: ${err}`);
      }
    });
    port.postMessage({
      type: 'start',
      paperId: paper.id,
      title: paper.title,
      pdfUrl: paper.pdfUrl || '',
      sessionId: wanted || (reconnect ? sessionId : null),
      fresh,
    });
  }

  function disconnect() {
    if (port) {
      const p = port;
      port = null;
      p.disconnect();
    }
  }

  function newChat() {
    if (!paper) return;
    connect(paper, { fresh: true });
    inputEl.focus();
  }

  async function sendPdf() {
    if (!paper.pdfUrl) {
      notice('No PDF is known for this paper, so Claude can\'t read it.');
      return;
    }
    notice('Downloading the paper…');
    try {
      const r = await fetch(paper.pdfUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      if (port) port.postMessage({ type: 'pdf', data: btoa(binary) });
    } catch (err) {
      notice(`Couldn't download the PDF: ${err.message}`);
    }
  }

  function setBusy(value) {
    busy = value;
    if (sendBtn) {
      sendBtn.textContent = busy ? 'Stop' : 'Send';
      sendBtn.title = busy ? 'Stop the answer' : 'Send (Enter)';
      sendBtn.classList.toggle('is-stop', busy);
    }
  }

  // ---- Images ----------------------------------------------------------------------

  // Claude takes images up to 5 MB and works at ~1.5k px anyway; bigger
  // screenshots are scaled down before they're attached.
  const MAX_IMAGE_SIDE = 2000;
  const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function prepareImage(file) {
    let blob = file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale < 1 || file.size > MAX_IMAGE_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size > MAX_IMAGE_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }
    bitmap.close();
    const src = await blobToDataUrl(blob);
    return { mediaType: blob.type, data: src.slice(src.indexOf(',') + 1), src };
  }

  async function addImage(file) {
    try {
      attachments.push(await prepareImage(file));
      renderAttachments();
    } catch (err) {
      notice(`Couldn't attach that image: ${err.message}`);
    }
  }

  function renderAttachments() {
    attachEl.hidden = !attachments.length;
    attachEl.innerHTML = attachments.map((a, i) => `
      <div class="chat-attachment">
        <img src="${a.src}" alt="">
        <button class="chat-attachment-remove" data-chat-action="remove-image" data-index="${i}" title="Remove" aria-label="Remove image">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>`).join('');
  }

  /** Sends `prompt` (a suggestion), or else what's typed, with any attached images. */
  function submit(prompt) {
    const text = (prompt || inputEl.value).trim();
    if (!text && !attachments.length) return;
    if (!prompt) {
      inputEl.value = '';
      autosize();
    }
    const images = attachments;
    attachments = [];
    renderAttachments();
    messages.push({
      role: 'user',
      parts: [...images.map((a) => ({ type: 'image', src: a.src })), ...(text ? [{ type: 'text', text }] : [])],
    });
    messages.push({ role: 'assistant', parts: [] });
    setBusy(true);
    renderAll();
    const ask = { text, images: images.map(({ mediaType, data }) => ({ mediaType, data })) };
    if (!port) {
      connect(paper, { reconnect: true, ask });
      return;
    }
    if (ready) port.postMessage({ type: 'ask', ...ask });
    else pendingAsk = ask;
  }

  function interrupt() {
    if (port) port.postMessage({ type: 'interrupt' });
  }

  function answerPermission(requestId, allow) {
    const part = lastAssistant().parts.find((p) => p.type === 'permission' && p.requestId === requestId);
    if (!part || part.answer) return;
    part.answer = allow ? 'allowed' : 'denied';
    if (port) port.postMessage({ type: 'permission', requestId, allow });
    queueRender();
  }

  function lastAssistant() {
    let last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') {
      last = { role: 'assistant', parts: [] };
      messages.push(last);
    }
    return last;
  }

  // ---- History -------------------------------------------------------------------

  function toggleHistory() {
    if (win.classList.contains('is-history')) {
      closeHistory();
      return;
    }
    if (!port) {
      notice('Claude bridge is not connected.');
      return;
    }
    win.classList.add('is-history');
    historyEl.hidden = false;
    historyEl.innerHTML = '<div class="chat-history-empty">Loading…</div>';
    port.postMessage({ type: 'sessions' });
  }

  function closeHistory() {
    if (!win) return;
    win.classList.remove('is-history');
    if (historyEl) historyEl.hidden = true;
  }

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderHistory(items) {
    if (!win.classList.contains('is-history')) return;
    if (!items.length) {
      historyEl.innerHTML = '<div class="chat-history-empty">No earlier chats about this paper yet.</div>';
      return;
    }
    historyEl.innerHTML = items.map((item) => `
      <button class="chat-history-item${item.id === sessionId ? ' is-current' : ''}" data-chat-action="open-session" data-session-id="${esc(item.id)}">
        <span class="chat-history-title">${esc(item.title || '(untitled)')}</span>
        <span class="chat-history-meta">${esc(when(item.active))} · ${item.prompts} question${item.prompts === 1 ? '' : 's'}${item.id === sessionId ? ' · current' : ''}</span>
      </button>`).join('');
  }

  function openSession(id) {
    if (!paper || !id) return;
    if (id === sessionId) {
      closeHistory();
      return;
    }
    connect(paper, { sessionId: id });
    inputEl.focus();
  }

  function onHostMessage(msg) {
    switch (msg.type) {
      case 'status':
        notice(msg.text);
        break;
      case 'need_pdf':
        sendPdf();
        break;
      case 'history':
        sessionId = msg.sessionId;
        messages = Array.isArray(msg.messages) ? msg.messages : [];
        renderAll();
        break;
      case 'sessions':
        renderHistory(msg.items || []);
        break;
      case 'ready':
        ready = true;
        if (msg.sessionId) sessionId = msg.sessionId;
        notice('');
        if (pendingAsk) {
          port.postMessage({ type: 'ask', ...pendingAsk });
          pendingAsk = null;
        }
        break;
      case 'text': {
        const parts = lastAssistant().parts;
        const last = parts[parts.length - 1];
        if (last && last.type === 'text') last.text += msg.text;
        else parts.push({ type: 'text', text: msg.text });
        queueRender();
        break;
      }
      case 'tool':
        lastAssistant().parts.push({ type: 'tool', name: msg.name, detail: msg.detail });
        queueRender();
        break;
      case 'permission':
        lastAssistant().parts.push({ type: 'permission', requestId: msg.requestId, tool: msg.tool, detail: msg.detail });
        queueRender();
        break;
      case 'error':
        lastAssistant().parts.push({ type: 'error', text: msg.message });
        queueRender();
        break;
      case 'done':
        setBusy(false);
        if (msg.sessionId) sessionId = msg.sessionId;
        queueRender();
        break;
    }
  }

  // ---- Rendering -------------------------------------------------------------------

  function partHtml(part) {
    if (part.type === 'text') return `<div class="chat-md">${markdown(part.text)}</div>`;
    if (part.type === 'tool') {
      return `<div class="chat-tool"><span class="chat-tool-name">${esc(part.name || 'Tool')}</span>${part.detail ? ` <span class="chat-tool-detail">${esc(part.detail)}</span>` : ''}</div>`;
    }
    if (part.type === 'permission') {
      const head = `<div class="chat-permission-text">Claude wants to use <strong>${esc(part.tool || 'a tool')}</strong>${part.detail ? `: <code>${esc(part.detail)}</code>` : ''}</div>`;
      const tail = part.answer
        ? `<div class="chat-permission-answer">${part.answer === 'allowed' ? 'Allowed' : 'Denied'}</div>`
        : `<div class="chat-permission-actions">
             <button class="chat-permission-btn is-allow" data-chat-action="allow" data-request-id="${esc(part.requestId)}">Allow</button>
             <button class="chat-permission-btn" data-chat-action="deny" data-request-id="${esc(part.requestId)}">Deny</button>
           </div>`;
      return `<div class="chat-permission">${head}${tail}</div>`;
    }
    if (part.type === 'error') return `<div class="chat-error">${esc(part.text)}</div>`;
    return '';
  }

  function messageHtml(message, isLast) {
    if (message.role === 'user') {
      // Images from an earlier session come without pixels (see the host).
      const images = message.parts.filter((p) => p.type === 'image').map((p) => (p.src
        ? `<img class="chat-msg-image" src="${p.src}" alt="">`
        : '<span class="chat-msg-image-chip">Image</span>')).join('');
      const text = message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      return `<div class="chat-msg is-user">${images ? `<div class="chat-msg-images">${images}</div>` : ''}${esc(text)}</div>`;
    }
    const body = message.parts.map(partHtml).join('');
    const thinking = isLast && busy && !message.parts.some((p) => p.type === 'text')
      ? '<div class="chat-thinking">Thinking…</div>'
      : '';
    return `<div class="chat-msg is-assistant">${body}${thinking}</div>`;
  }

  function renderAll() {
    if (!listEl) return;
    if (!messages.length) {
      listEl.innerHTML = `
        <div class="chat-empty">
          <div class="chat-empty-title">Ask anything about this paper</div>
          <div class="chat-empty-hint">Runs your Claude Code: your subscription, settings and tools, with the PDF in its working folder.</div>
          <button class="chat-suggestion" data-chat-action="suggest">${esc(SUGGESTION)}</button>
        </div>`;
      return;
    }
    listEl.innerHTML = messages.map((m, i) => messageHtml(m, i === messages.length - 1)).join('');
    listEl.scrollTop = listEl.scrollHeight;
  }

  // Streaming updates repaint only the last message, once per frame.
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!listEl) return;
      const lastEl = listEl.lastElementChild;
      const last = messages[messages.length - 1];
      const stick = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      if (lastEl && last && last.role === 'assistant' && lastEl.classList.contains('is-assistant')) {
        lastEl.outerHTML = messageHtml(last, true);
      } else {
        renderAll();
        return;
      }
      if (stick) listEl.scrollTop = listEl.scrollHeight;
    });
  }

  // Transcripts used to be copied into chrome.storage.local as chat:<paperId>;
  // the host reads Claude Code's own transcripts now, so drop the copies.
  chrome.storage.local.getKeys().then((keys) => {
    const stale = keys.filter((k) => k.startsWith('chat:'));
    if (stale.length) chrome.storage.local.remove(stale);
  });

  // ---- Triggers --------------------------------------------------------------------

  addEventListener('keydown', (e) => {
    // Option+Space toggles the chat while a paper is open in the reader.
    if (e.altKey && e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (!window.PaperViewer || !window.PaperViewer.isOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isShown()) hide();
      else show();
      return;
    }
    // Option+N starts a new chat while the chat is open. (Cmd+N can't be used:
    // Chrome keeps it for New Window and never delivers it to the page.)
    // e.code, since Option+N on a Mac is the dead key for "˜"; handling the
    // keydown keeps the tilde out of the input.
    if (isShown() && e.altKey && e.code === 'KeyN' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!busy) newChat();
      return;
    }
    // Esc leaves the history list, then closes the chat, before anything
    // else (the reader stays open).
    if (e.key === 'Escape' && isShown()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (win.classList.contains('is-history')) closeHistory();
      else hide();
    }
  }, true);

  // The session follows the reader: another paper opened, or the reader closed.
  document.addEventListener('paperviewer:change', (e) => {
    const detail = e.detail;
    if (!detail) {
      disconnect();
      paper = null;
      if (win) win.hidden = true;
      return;
    }
    if (paper && detail.paper.id !== paper.id) {
      disconnect();
      paper = null;
      if (isShown()) show();
    }
  });
})();
