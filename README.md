# PaperClip

**Every paper you've ever opened, in one library.**

PaperClip is a Chrome extension that turns your new tab page into a Zotero-style library of every academic paper you've encountered. It auto-captures papers as you browse, persists them permanently, and enriches each entry with title, authors, year, and venue from public APIs.

No server. No account. No data leaves your machine — except the small lookup requests to arXiv / OpenReview / Crossref / Semantic Scholar to fetch metadata.

---

## Install

**1. Clone the repo**

```bash
git clone https://github.com/sseanliu/PaperClip.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder inside the cloned repo

**3. Open a new tab**

You'll see your library — empty at first. Browse to any arXiv / OpenReview / etc. page, then open a new tab. The paper appears.

---

## Features

- **Auto-capture** — visit a paper, it lands in your library. No clicks, no buttons.
- **Permanent history** — papers stay even after you close the tab. Survives browser restarts.
- **Metadata enrichment** — pulls title, authors, year, venue from public APIs (arXiv, OpenReview, Crossref, Semantic Scholar).
- **Smart deduplication** — `arxiv.org/abs/X` and `arxiv.org/pdf/X.pdf` collapse into one entry.
- **Open-tab indicator** — a green dot marks papers currently open in a tab; click the row to jump there.
- **Search** — filter by title, author, or venue.
- **Read / unread toggle** — mark papers as read so the unread queue stays scannable.
- **Backfill** — already had paper tabs open before installing? They'll all show up on your next new-tab open.
- **Sources supported** — arXiv, OpenReview, bioRxiv, medRxiv, ACM, IEEE, Springer, Nature, Science, NeurIPS proceedings, PMLR, ACL Anthology, Semantic Scholar, plus any URL ending in `.pdf`.

---

## How it works

```
You browse to a paper URL
  -> Service worker classifies it (arXiv, OpenReview, PDF, etc.)
  -> Persists to chrome.storage.local with a canonical ID
  -> Background queue fetches title/authors/year/venue from public APIs
  -> Your library updates live (no refresh needed)
```

Each paper is keyed by a canonical ID like `arxiv:2401.12345` so revisits and URL variants don't create duplicates.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Capture | Service worker listens to `chrome.tabs.onUpdated` |
| Enrichment | arXiv API · OpenReview API · Crossref · Semantic Scholar |
| UI | Vanilla HTML/CSS/JS — no framework |

---

## License

MIT
