/**
 * chat.js — Option+Space in the reader opens a Claude Code session about the
 * open paper. native/claude_host.py runs it over native messaging: the
 * user's own `claude` CLI, login (subscription), settings and tools, with
 * the PDF in the session's working directory. Answers stream in here; tool
 * calls that need approval show Allow / Deny.
 *
 * One session per paper: reopening a paper resumes its conversation, and the
 * transcript is kept in chrome.storage.local (chat:<paperId>) so it shows
 * again. "New chat" starts over.
 */
(function () {
  const HOST = 'com.xiaoan.paperclip.claude';
  const MAX_SAVED_MESSAGES = 100;

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
  let pendingAsk = null; // text typed before the session was ready
  let messages = []; // { role: 'user' | 'assistant', parts: [...] }
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

  function textBlocks(text) {
    return text.split(/\n{2,}/).map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';
      const heading = lines.length === 1 && lines[0].match(/^#{1,4}\s+(.*)$/);
      if (heading) return `<h4>${inline(heading[1])}</h4>`;
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  function markdown(src) {
    // Odd pieces sit between ``` fences; a fence still streaming in shows as code.
    return src.split('```').map((piece, i) => (i % 2
      ? `<pre><code>${esc(piece.replace(/^[\w+-]*\n/, ''))}</code></pre>`
      : textBlocks(piece))).join('');
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
        <button class="chat-icon-btn" data-chat-action="new" title="New chat" aria-label="New chat">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <button class="chat-icon-btn" data-chat-action="close" title="Close (Esc)" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="chat-list" id="chatList"></div>
      <div class="chat-notice" id="chatNotice" hidden></div>
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

    win.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-chat-action]');
      if (!btn) return;
      const action = btn.dataset.chatAction;
      if (action === 'close') hide();
      else if (action === 'new') newChat();
      else if (action === 'send') (busy ? interrupt() : submit());
      else if (action === 'allow' || action === 'deny') answerPermission(btn.dataset.requestId, action === 'allow');
    });
    inputEl.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a new line; Enter while composing (IME) is not a send.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!busy) submit();
      }
    });
    inputEl.addEventListener('input', autosize);
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

  function storageKey(id) {
    return `chat:${id}`;
  }

  /**
   * Opens the host and starts (or resumes) the paper's session. `fresh` drops
   * the saved conversation; `reconnect` keeps the messages on screen (the
   * bridge went away mid-conversation) and sends `ask` once ready.
   */
  async function connect(next, { fresh = false, reconnect = false, ask = null } = {}) {
    disconnect();
    paper = next;
    ready = false;
    pendingAsk = ask;
    if (!reconnect) setBusy(false);
    titleEl.textContent = paper.title;
    titleEl.title = paper.title;
    if (fresh) {
      messages = [];
      await chrome.storage.local.remove(storageKey(paper.id));
    } else if (!reconnect) {
      const stored = (await chrome.storage.local.get(storageKey(paper.id)))[storageKey(paper.id)];
      messages = Array.isArray(stored) ? stored : [];
    }
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
    port.postMessage({ type: 'start', paperId: paper.id, title: paper.title, pdfUrl: paper.pdfUrl || '', resume: !fresh });
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

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autosize();
    messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    messages.push({ role: 'assistant', parts: [] });
    setBusy(true);
    renderAll();
    if (!port) {
      connect(paper, { reconnect: true, ask: text });
      return;
    }
    if (ready) port.postMessage({ type: 'ask', text });
    else pendingAsk = text;
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

  function save() {
    if (!paper) return;
    // Permission prompts only make sense live; keep what they were answered.
    const kept = messages.slice(-MAX_SAVED_MESSAGES).map((m) => ({
      role: m.role,
      parts: m.parts.filter((p) => p.type !== 'permission' || p.answer),
    }));
    chrome.storage.local.set({ [storageKey(paper.id)]: kept });
  }

  function onHostMessage(msg) {
    switch (msg.type) {
      case 'status':
        notice(msg.text);
        break;
      case 'need_pdf':
        sendPdf();
        break;
      case 'ready':
        ready = true;
        notice('');
        if (pendingAsk) {
          port.postMessage({ type: 'ask', text: pendingAsk });
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
        queueRender();
        save();
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
      return `<div class="chat-msg is-user">${esc(message.parts.map((p) => p.text).join(''))}</div>`;
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
    // Esc closes the chat before anything else (the reader stays open).
    if (e.key === 'Escape' && isShown()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hide();
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
