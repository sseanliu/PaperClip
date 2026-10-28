import {
  AnnotationLayer,
  CanvasLayer,
  CustomLayer,
  CurrentPage,
  CurrentZoom,
  HighlightLayer,
  NextPage,
  Page,
  Pages,
  PreviousPage,
  Root,
  Search,
  TextLayer,
  Thumbnail,
  Thumbnails,
  TotalPages,
  ZoomIn,
  ZoomOut,
  calculateHighlightRects,
  usePdf,
  usePdfJump,
  useSearch,
  useSelectionDimensions,
} from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/lector-pdf.worker.min.mjs");

// pdf.js styles text-layer spans with the FALLBACK font family only, so the
// invisible selectable text is measured in sans-serif while the canvas draws
// the embedded font: intra-line character positions drift and word selection
// lands off by a character. The embedded fonts ARE loaded (FontLoader adds
// them to document.fonts as g_*), so rewrite the text-content styles to lead
// with the loaded family: TextLayer then measures, calibrates --scale-x, and
// renders selection geometry against the true glyph metrics.
let textContentPatched = false;
function patchTextContentFonts(pageProxy) {
  if (textContentPatched) return;
  textContentPatched = true;
  const proto = Object.getPrototypeOf(pageProxy);
  const orig = proto.streamTextContent;
  proto.streamTextContent = function (...args) {
    const stream = orig.apply(this, args);
    const reader = stream.getReader();
    return new ReadableStream({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value && value.styles) {
          for (const [name, style] of Object.entries(value.styles)) {
            if (name.startsWith("g_") && style.fontFamily && !style.fontFamily.includes(name)) {
              style.fontFamily = `"${name}", ${style.fontFamily}`;
            }
          }
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };
}

const I = ({ children, size = 15 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

function FitWidthButton() {
  const zoomFitWidth = usePdf((s) => s.zoomFitWidth);
  return (
    <button type="button" className="lector-btn" title="Fit to width" onClick={() => zoomFitWidth()}>
      <I>
        <path d="M3 12h18" />
        <path d="m6 9-3 3 3 3" />
        <path d="m18 9 3 3-3 3" />
      </I>
    </button>
  );
}

function ResultItem({ result, searchText }) {
  const { jumpToHighlightRects } = usePdfJump();
  const getPdfPageProxy = usePdf((s) => s.getPdfPageProxy);
  const onClick = async () => {
    const pageProxy = getPdfPageProxy(result.pageNumber);
    const rects = await calculateHighlightRects(pageProxy, {
      pageNumber: result.pageNumber,
      text: result.text,
      matchIndex: result.matchIndex,
      searchText,
    });
    jumpToHighlightRects(rects, "pixels");
  };
  return (
    <div className="lector-search-result" onClick={onClick}>
      <div className="lector-search-result-text">{result.text}</div>
      <div className="lector-search-result-page">p. {result.pageNumber}</div>
    </div>
  );
}

function SearchPane({ onClose }) {
  const [text, setText] = useState("");
  const { searchResults, search } = useSearch();
  useEffect(() => {
    const t = setTimeout(() => search(text, { limit: 12 }), 300);
    return () => clearTimeout(t);
  }, [text, search]);
  const exact = searchResults?.exactMatches ?? [];
  const fuzzy = (searchResults?.fuzzyMatches ?? []).filter((r) => !r.isExactMatch);
  return (
    <div className="lector-search-pane">
      <input
        className="lector-search-input"
        autoFocus
        placeholder="Search in paper…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      {text && !exact.length && !fuzzy.length && <div className="lector-search-empty">No matches.</div>}
      {exact.map((r) => (
        <ResultItem key={`e${r.pageNumber}-${r.matchIndex}`} result={r} searchText={text} />
      ))}
      {fuzzy.length > 0 && <div className="lector-search-group">Similar</div>}
      {fuzzy.map((r) => (
        <ResultItem key={`f${r.pageNumber}-${r.matchIndex}`} result={r} />
      ))}
    </div>
  );
}

// Scholar-style selection: native ::selection is transparent; we repaint the
// live selection as merged, line-consolidated bands via Lector's geometry.
const selStore = {
  rects: [],
  listeners: new Set(),
  set(rects) {
    selStore.rects = rects;
    for (const l of selStore.listeners) l();
  },
  subscribe(l) {
    selStore.listeners.add(l);
    return () => selStore.listeners.delete(l);
  },
  get() {
    return selStore.rects;
  },
};

function SelectionWatcher() {
  const { getAnnotationDimension } = useSelectionDimensions();
  useEffect(() => {
    let raf = 0;
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        if (selStore.rects.length) selStore.set([]);
        return;
      }
      const dim = getAnnotationDimension();
      selStore.set(dim?.highlights ?? []);
    };
    const onSel = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      cancelAnimationFrame(raf);
    };
  }, [getAnnotationDimension]);
  return null;
}

function SelectionRects({ pageNumber }) {
  const rects = useSyncExternalStore(selStore.subscribe, selStore.get);
  const mine = rects.filter((r) => r.pageNumber === pageNumber);
  if (!mine.length) return null;
  return (
    <div className="lector-sel-layer">
      {mine.map((r, i) => (
        <div
          key={i}
          className="lector-sel"
          style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
        />
      ))}
    </div>
  );
}

// Opens the paper at a reading width (pageWidth CSS px) rather than filling
// the full-screen window; on a window narrower than that it fits the width.
// Runs once per document, when page sizes are known.
function InitialZoom({ pageWidth }) {
  const viewports = usePdf((s) => s.viewports);
  const updateZoom = usePdf((s) => s.updateZoom);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !viewports || !viewports.length) return;
    done.current = true;
    const widest = Math.max(...viewports.map((v) => v.width));
    // The page column may not be laid out yet; the root is, and spans it.
    // (zoomFitWidth is a no-op this early, so fit by hand.)
    const root = document.getElementById("lectorRoot");
    const room = root ? root.clientWidth : pageWidth;
    updateZoom(Math.min(pageWidth, room) / widest, false);
  }, [viewports, updateZoom, pageWidth]);
  return null;
}

// The toolbar floats over the top of the paper and hides while you read. It
// comes back when the pointer nears the top edge, stays while hovered or
// while one of its inputs has focus, and shows briefly when a paper opens so
// it's discoverable.
const TOOLBAR_REVEAL_PX = 96;
const TOOLBAR_HIDE_MS = 1200;
const TOOLBAR_FIRST_SHOW_MS = 2500;

function useAutoHideToolbar() {
  const [shown, setShown] = useState(true);
  const hovering = useRef(false);
  const timer = useRef(0);
  const scheduleHide = useCallback((ms = TOOLBAR_HIDE_MS) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const active = document.activeElement;
      if (hovering.current || (active && active.closest && active.closest(".lector-toolbar"))) return;
      setShown(false);
    }, ms);
  }, []);
  useEffect(() => {
    scheduleHide(TOOLBAR_FIRST_SHOW_MS);
    return () => clearTimeout(timer.current);
  }, [scheduleHide]);
  const onMouseMove = useCallback(
    (e) => {
      if (e.clientY - e.currentTarget.getBoundingClientRect().top < TOOLBAR_REVEAL_PX) {
        clearTimeout(timer.current);
        setShown(true);
      } else {
        scheduleHide();
      }
    },
    [scheduleHide],
  );
  const toolbarHandlers = {
    onMouseEnter: () => {
      hovering.current = true;
      clearTimeout(timer.current);
      setShown(true);
    },
    onMouseLeave: () => {
      hovering.current = false;
      scheduleHide();
    },
  };
  return { shown, onMouseMove, toolbarHandlers };
}

function Viewer({ url, onError, pageWidth = 1000, title, onClose, onOpenTab }) {
  const [showThumbs, setShowThumbs] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const toolbar = useAutoHideToolbar();
  return (
    <Root
      source={url}
      zoom={pageWidth / 612}
      id="lectorRoot"
      tabIndex={-1}
      className="lector-root"
      onError={onError}
      onDocumentLoad={({ proxy }) => {
        proxy.getPage(1).then(patchTextContentFonts).catch(() => {});
      }}
      loader={<div className="lector-loading">Loading PDF…</div>}
    >
      <SelectionWatcher />
      <InitialZoom pageWidth={pageWidth} />
      <Search>
        <div className="lector-shell" onMouseMove={toolbar.onMouseMove}>
          <div className={`lector-toolbar${toolbar.shown ? "" : " is-hidden"}`} {...toolbar.toolbarHandlers}>
            <button
              type="button"
              className={`lector-btn${showThumbs ? " is-on" : ""}`}
              title="Thumbnails"
              onClick={() => setShowThumbs((v) => !v)}
            >
              <I>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </I>
            </button>
            {title && (
              <span className="lector-title" title={title}>
                {title}
              </span>
            )}
            <span className="lector-toolbar-spacer" />
            <PreviousPage className="lector-btn" title="Previous page">
              <I>
                <path d="m15 18-6-6 6-6" />
              </I>
            </PreviousPage>
            <span className="lector-pageinfo">
              <CurrentPage className="lector-pagenum" /> / <TotalPages />
            </span>
            <NextPage className="lector-btn" title="Next page">
              <I>
                <path d="m9 18 6-6-6-6" />
              </I>
            </NextPage>
            <span className="lector-toolbar-spacer" />
            <ZoomOut className="lector-btn" title="Zoom out">
              <I>
                <path d="M5 12h14" />
              </I>
            </ZoomOut>
            <CurrentZoom className="lector-zoom" />
            <ZoomIn className="lector-btn" title="Zoom in">
              <I>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </I>
            </ZoomIn>
            <FitWidthButton />
            <button
              type="button"
              className={`lector-btn${showSearch ? " is-on" : ""}`}
              title="Search in paper"
              onClick={() => setShowSearch((v) => !v)}
            >
              <I>
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </I>
            </button>
            {onOpenTab && (
              <button type="button" className="lector-btn" title="Open in a tab" onClick={onOpenTab}>
                <I>
                  <path d="M15 3h6v6" />
                  <path d="M10 14 21 3" />
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                </I>
              </button>
            )}
            {onClose && (
              <button type="button" className="lector-btn" title="Close" onClick={onClose}>
                <I>
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </I>
              </button>
            )}
          </div>
          <div className="lector-main">
            {showThumbs && (
              <Thumbnails className="lector-thumbs">
                <Thumbnail className="lector-thumb" />
              </Thumbnails>
            )}
            <Pages className="lector-pages">
              <Page>
                <CanvasLayer />
                <TextLayer />
                <AnnotationLayer />
                <HighlightLayer className="lector-hl" />
                <CustomLayer>{(n) => <SelectionRects pageNumber={n} />}</CustomLayer>
              </Page>
            </Pages>
            {showSearch && <SearchPane onClose={() => setShowSearch(false)} />}
          </div>
        </div>
      </Search>
    </Root>
  );
}

const roots = new WeakMap();

window.LectorPanel = {
  mount(container, url, { onError, pageWidth, title, onClose, onOpenTab } = {}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(
      <Viewer
        url={url}
        onError={onError}
        pageWidth={pageWidth}
        title={title}
        onClose={onClose}
        onOpenTab={onOpenTab}
      />,
    );
  },
  unmount(container) {
    const root = roots.get(container);
    if (root) {
      root.unmount();
      roots.delete(container);
    }
  },
};
