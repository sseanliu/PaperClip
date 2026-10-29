#!/usr/bin/env python3
"""Chrome native-messaging host: a Claude Code session about one paper.

The reader's chat window (extension/chat.js) opens a port with
chrome.runtime.connectNative('com.xiaoan.paperclip.claude'); Chrome keeps
this process alive for the port's lifetime. Framing: 4-byte little-endian
length prefix + UTF-8 JSON, both directions. Host -> extension messages must
stay under Chrome's 1 MB cap; extension -> host can be up to 64 MB (the PDF).

The session is a plain `claude -p` run: the user's own login (subscription),
settings, permission mode, CLAUDE.md, skills and MCP servers. The only
addition is a note naming the open paper, whose PDF sits in the working
directory. Tool calls that need approval come over stdout as control
requests (--permission-prompts host with --permission-prompt-tool stdio;
without the latter they are denied) and are forwarded to the chat window.
Wire formats verified against CLI 2.1.312 (2026-10-28): the reply to a
can_use_tool request is nested, {"type": "control_response", "response":
{"subtype": "success", "request_id", "response": {"behavior", ...}}}.

Sessions are Claude Code's own transcripts: every paper has its own working
directory, so ~/.claude/projects/<that directory, slugged>/*.jsonl holds all
of its conversations. The chat's history list and the messages shown for a
session are read from there (titles are the first question: -p sessions
get no ai-title); nothing is stored separately.

Extension -> host
  {"type": "start", "paperId", "title", "pdfUrl", "sessionId"?, "fresh"?}
                                           resumes sessionId, else the latest
                                           session; fresh starts a new one
  {"type": "sessions"}                     list this paper's sessions
  {"type": "pdf", "data": base64}          reply to need_pdf
  {"type": "ask", "text", "images"?: [{"mediaType", "data": base64}]}
  {"type": "permission", "requestId", "allow": bool}
  {"type": "interrupt"}
Host -> extension
  {"type": "status", "text"}
  {"type": "need_pdf"}                     the host couldn't download it
  {"type": "history", "sessionId", "messages"}   the resumed session so far;
                                           images in it are {"type": "image", "ref"}
  {"type": "history_image", "sessionId", "ref", "mediaType", "chunk", "last"}
                                           an image's base64 in pieces under the
                                           1 MB message cap, sent after history
  {"type": "sessions", "items": [{"id", "title", "prompts", "created", "active"}]}
  {"type": "ready", "sessionId", "resumed": bool}
  {"type": "text", "text"}                 assistant text, streamed
  {"type": "tool", "name", "detail"}
  {"type": "permission", "requestId", "tool", "detail"}
  {"type": "done", "sessionId", "error": bool}
  {"type": "error", "message"}

Python 3.9 compatible: Chrome starts hosts with the system python3.
"""

import base64
import hashlib
import itertools
import json
import os
import pwd
import re
import shutil
import struct
import subprocess
import sys
import threading
import traceback
import urllib.request
from pathlib import Path

HOME = Path.home()
ROOT = HOME / "Library" / "Caches" / "PaperClip" / "claude"
PROJECTS = HOME / ".claude" / "projects"
HISTORY_BUDGET = 900_000  # bytes of history JSON per message (Chrome caps a host message at 1 MB)
IMAGE_CHUNK = 700_000  # base64 characters per history_image message
LOG = Path("/tmp/paperclip-claude-host.log")
# Chrome starts hosts with a minimal PATH; claude and the tools it runs live here.
EXTRA_PATH = [str(HOME / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"

out_lock = threading.Lock()
request_ids = itertools.count(1)


def log(msg):
    with LOG.open("a") as f:
        f.write(msg.rstrip() + "\n")


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length))


def child_env():
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(EXTRA_PATH + [env.get("PATH", "/usr/bin:/bin")])
    # claude finds its login in the keychain by user name; without USER it
    # reports "Not logged in".
    user = pwd.getpwuid(os.getuid()).pw_name
    env.setdefault("USER", user)
    env.setdefault("LOGNAME", user)
    env.setdefault("HOME", str(HOME))
    return env


def find_claude():
    return shutil.which("claude", path=child_env()["PATH"])


def transcripts_dir(cwd):
    # Claude Code names a project's folder after its working directory with
    # every non-alphanumeric character turned into "-".
    return PROJECTS / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def scan_transcript(path, images=None):
    """The session as chat messages ({role, parts}) plus its list entry. When
    `images` is a list, pasted images are appended to it as (mediaType, data)
    and their parts carry the index as "ref"."""
    messages = []
    first_ts = last_ts = ""
    title = ""
    prompts = 0
    for line in open(path, encoding="utf-8", errors="ignore"):
        if '"type":"user"' not in line and '"type":"assistant"' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("isSidechain") or o.get("isMeta"):
            continue
        ts = o.get("timestamp") or ""
        content = (o.get("message") or {}).get("content")
        if o.get("type") == "user":
            # A typed question is a string, or a list when images were pasted
            # with it; tool results also come back as lists.
            if isinstance(content, str):
                blocks = [{"type": "text", "text": content}]
            elif isinstance(content, list) and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                blocks = [b for b in content if isinstance(b, dict)]
            else:
                continue
            parts = []
            for b in blocks:
                if b.get("type") == "text" and b.get("text", "").strip() and not b["text"].startswith("<"):
                    parts.append({"type": "text", "text": b["text"]})
                elif b.get("type") == "image":
                    # Pixels travel separately (history_image): a few screenshots
                    # would pass the 1 MB message cap.
                    part = {"type": "image"}
                    source = b.get("source") or {}
                    if images is not None and source.get("type") == "base64" and source.get("data"):
                        part["ref"] = len(images)
                        images.append((source.get("media_type") or "image/png", source["data"]))
                    parts.append(part)
            if not parts:
                continue
            prompts += 1
            text = " ".join(p["text"] for p in parts if p["type"] == "text")
            title = title or (" ".join(text.split())[:120] if text else "(image)")
            messages.append({"role": "user", "parts": parts})
        else:
            if not isinstance(content, list):
                continue
            if not messages or messages[-1]["role"] != "assistant":
                messages.append({"role": "assistant", "parts": []})
            parts = messages[-1]["parts"]
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    if parts and parts[-1]["type"] == "text":
                        parts[-1]["text"] += "\n\n" + block["text"]
                    else:
                        parts.append({"type": "text", "text": block["text"]})
                elif block.get("type") == "tool_use":
                    parts.append({"type": "tool", "name": block.get("name"), "detail": summarize_input(block.get("name"), block.get("input"))})
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
    entry = {"id": Path(path).stem, "title": title, "prompts": prompts, "created": first_ts, "active": last_ts}
    return messages, entry


def list_sessions(cwd):
    """This paper's sessions with at least one question, most recently active first."""
    items = []
    for path in transcripts_dir(cwd).glob("*.jsonl"):
        try:
            _, entry = scan_transcript(path)
        except Exception:
            log("scan failed " + str(path) + ":\n" + traceback.format_exc())
            continue
        if entry["prompts"]:
            items.append(entry)
    items.sort(key=lambda e: e["active"], reverse=True)
    return items


def history_for(cwd, session_id):
    """(messages, images) of a session; images as (mediaType, base64)."""
    path = transcripts_dir(cwd) / (session_id + ".jsonl")
    if not path.exists():
        return [], []
    images = []
    messages, _ = scan_transcript(path, images)
    # Keep the newest messages that fit in one native message.
    while messages and len(json.dumps(messages)) > HISTORY_BUDGET:
        messages = messages[1:]
    return messages, images


def send_history(cwd, session_id):
    messages, images = history_for(cwd, session_id)
    send({"type": "history", "sessionId": session_id, "messages": messages})
    kept = {p["ref"] for m in messages for p in m["parts"] if p.get("type") == "image" and "ref" in p}
    for ref, (media_type, data) in enumerate(images):
        if ref not in kept:
            continue
        for start in range(0, len(data), IMAGE_CHUNK):
            send({
                "type": "history_image",
                "sessionId": session_id,
                "ref": ref,
                "mediaType": media_type,
                "chunk": data[start:start + IMAGE_CHUNK],
                "last": start + IMAGE_CHUNK >= len(data),
            })


def paper_dir(paper_id):
    # Readable prefix plus a hash, so ids like "url:https://..." stay valid names.
    slug = "".join(c if c.isalnum() else "-" for c in paper_id)[:60].strip("-")
    digest = hashlib.sha1(paper_id.encode("utf-8")).hexdigest()[:10]
    return ROOT / "papers" / f"{slug}-{digest}"


def download_pdf(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data.startswith(b"%PDF"):
        raise ValueError("not a PDF (the site may need a login)")
    dest.write_bytes(data)


def summarize_input(name, tool_input):
    """One short line describing what a tool call does, for the chat window."""
    if not isinstance(tool_input, dict):
        return ""
    for key in ("command", "file_path", "path", "pattern", "url", "query", "description", "prompt"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            value = value.replace(str(HOME), "~")
            return value if len(value) <= 300 else value[:297] + "..."
    return ""


class Session:
    def __init__(self):
        self.proc = None
        self.paper = None  # {"paperId", "title", "pdfUrl", "dir"}
        self.session_id = None
        self.pending = {}  # permission request_id -> tool input, awaiting the user

    # ---- lifecycle -------------------------------------------------------------

    def start(self, msg):
        self.stop_process()
        paper_id = msg.get("paperId") or ""
        if not paper_id:
            send({"type": "error", "message": "no paper"})
            return
        directory = paper_dir(paper_id)
        directory.mkdir(parents=True, exist_ok=True)
        self.paper = {"paperId": paper_id, "title": msg.get("title") or "", "pdfUrl": msg.get("pdfUrl") or "", "dir": directory}
        if msg.get("fresh"):
            self.session_id = None
        elif msg.get("sessionId"):
            self.session_id = msg["sessionId"]
        else:
            latest = list_sessions(directory)
            self.session_id = latest[0]["id"] if latest else None
        if self.session_id:
            send_history(directory, self.session_id)
        pdf = directory / "paper.pdf"
        if not pdf.exists():
            if self.paper["pdfUrl"]:
                send({"type": "status", "text": "Downloading the paper..."})
                try:
                    download_pdf(self.paper["pdfUrl"], pdf)
                except Exception as e:
                    log(f"download failed {self.paper['pdfUrl']}: {e}")
            if not pdf.exists():
                send({"type": "need_pdf"})
                return
        self.spawn()

    def send_sessions(self):
        items = list_sessions(self.paper["dir"]) if self.paper else []
        send({"type": "sessions", "items": items, "current": self.session_id})

    def receive_pdf(self, msg):
        if not self.paper:
            return
        try:
            (self.paper["dir"] / "paper.pdf").write_bytes(base64.b64decode(msg.get("data") or ""))
        except Exception as e:
            send({"type": "error", "message": f"could not save the PDF: {e}"})
            return
        self.spawn()

    def spawn(self):
        claude = find_claude()
        if not claude:
            send({"type": "error", "message": "claude CLI not found (looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)"})
            return
        title = self.paper["title"] or "this paper"
        note = (
            f'The user is reading the paper "{title}" in PaperClip and opened this chat from it. '
            "Its PDF is ./paper.pdf in the working directory"
            + (f" (source: {self.paper['pdfUrl']})" if self.paper["pdfUrl"] else "")
            + ". Questions are about this paper unless they say otherwise; read the PDF before "
            "answering the first one. The chat window renders Markdown and LaTeX (KaTeX): write "
            "math as $...$ inline or $$...$$ on its own lines, not as plain text or Unicode "
            "symbols."
        )
        args = [
            claude, "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompts", "host",
            "--permission-prompt-tool", "stdio",
            "--append-system-prompt", note,
        ]
        resumed = bool(self.session_id)
        if resumed:
            args += ["--resume", self.session_id]
        self.proc = subprocess.Popen(
            args,
            cwd=str(self.paper["dir"]),
            env=child_env(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        threading.Thread(target=self.pump_stdout, args=(self.proc,), daemon=True).start()
        threading.Thread(target=self.pump_stderr, args=(self.proc,), daemon=True).start()
        send({"type": "ready", "sessionId": self.session_id, "resumed": resumed})

    def stop_process(self):
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

    # ---- talking to claude ------------------------------------------------------

    def write(self, obj):
        if not self.proc or self.proc.poll() is not None:
            # The process went away (interrupted, crashed): pick the session back up.
            if not self.paper:
                send({"type": "error", "message": "no paper"})
                return False
            self.spawn()
        try:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
            return True
        except Exception as e:
            send({"type": "error", "message": f"claude stopped: {e}"})
            return False

    def ask(self, msg):
        text = (msg.get("text") or "").strip()
        images = [i for i in (msg.get("images") or []) if isinstance(i, dict) and i.get("data")]
        if not text and not images:
            return
        if images:
            content = [
                {"type": "image", "source": {"type": "base64", "media_type": i.get("mediaType") or "image/png", "data": i["data"]}}
                for i in images
            ]
            content.append({"type": "text", "text": text or "(see the image)"})
        else:
            content = text
        self.write({"type": "user", "message": {"role": "user", "content": content}})

    def answer_permission(self, msg):
        request_id = msg.get("requestId")
        if request_id not in self.pending:
            return
        tool_input = self.pending.pop(request_id)
        if msg.get("allow"):
            body = {"behavior": "allow", "updatedInput": tool_input}
        else:
            body = {"behavior": "deny", "message": "The user declined this in the PaperClip chat."}
        self.write({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": body}})

    def interrupt(self):
        if not self.proc or self.proc.poll() is not None:
            return
        self.pending.clear()
        self.write({"type": "control_request", "request_id": f"interrupt-{next(request_ids)}", "request": {"subtype": "interrupt"}})

    def pump_stdout(self, proc):
        for raw in proc.stdout:
            try:
                event = json.loads(raw)
            except Exception:
                continue
            try:
                self.on_event(event)
            except Exception:
                log("event error:\n" + traceback.format_exc())
        if proc is self.proc:
            code = proc.wait()
            if code:
                send({"type": "error", "message": f"claude exited with code {code} (see {LOG})"})

    def pump_stderr(self, proc):
        for raw in proc.stderr:
            log("claude: " + raw.decode("utf-8", "replace"))

    def on_event(self, event):
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            sid = event.get("session_id")
            if sid:
                self.session_id = sid
            return
        if kind == "stream_event":
            inner = event.get("event") or {}
            delta = inner.get("delta") or {}
            if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                # Subagent output (parent_tool_use_id set) stays out of the chat.
                if not event.get("parent_tool_use_id"):
                    send({"type": "text", "text": delta.get("text", "")})
            return
        if kind == "assistant" and not event.get("parent_tool_use_id"):
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    send({"type": "tool", "name": block.get("name"), "detail": summarize_input(block.get("name"), block.get("input"))})
            return
        if kind == "control_request":
            request = event.get("request") or {}
            if request.get("subtype") == "can_use_tool":
                request_id = event.get("request_id")
                self.pending[request_id] = request.get("input") or {}
                name = request.get("display_name") or request.get("tool_name")
                send({
                    "type": "permission",
                    "requestId": request_id,
                    "tool": name,
                    "detail": request.get("description") or summarize_input(request.get("tool_name"), request.get("input")),
                })
            return
        if kind == "result":
            sid = event.get("session_id") or self.session_id
            self.session_id = sid
            if event.get("is_error") and event.get("result"):
                send({"type": "error", "message": str(event.get("result"))[:500]})
            send({"type": "done", "sessionId": sid, "error": bool(event.get("is_error"))})
            return


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    session = Session()
    try:
        while True:
            try:
                msg = read_message()
            except Exception:
                log("bad frame:\n" + traceback.format_exc())
                break
            if msg is None:
                break
            kind = msg.get("type")
            try:
                if kind == "start":
                    session.start(msg)
                elif kind == "pdf":
                    session.receive_pdf(msg)
                elif kind == "sessions":
                    session.send_sessions()
                elif kind == "ask":
                    session.ask(msg)
                elif kind == "permission":
                    session.answer_permission(msg)
                elif kind == "interrupt":
                    session.interrupt()
                else:
                    log(f"unknown message {kind!r}")
            except Exception:
                log("handler error:\n" + traceback.format_exc())
                send({"type": "error", "message": f"host error handling {kind} (see {LOG})"})
    finally:
        session.stop_process()


if __name__ == "__main__":
    main()
