import {
  AnnotationLayer,
  CanvasLayer,
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
} from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/lector-pdf.worker.min.mjs");

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

function Viewer({ url, onError }) {
  const [showThumbs, setShowThumbs] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  return (
    <Root
      source={url}
      isZoomFitWidth
      id="lectorRoot"
      tabIndex={-1}
      className="lector-root"
      onError={onError}
      loader={<div className="lector-loading">Loading PDF…</div>}
    >
      <Search>
        <div className="lector-shell">
          <div className="lector-toolbar">
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
  mount(container, url, { onError } = {}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(<Viewer url={url} onError={onError} />);
  },
  unmount(container) {
    const root = roots.get(container);
    if (root) {
      root.unmount();
      roots.delete(container);
    }
  },
};
