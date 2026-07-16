import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/lector-pdf.worker.min.mjs");

function Viewer({ url, onError }) {
  return createElement(
    Root,
    {
      source: url,
      isZoomFitWidth: true,
      id: "lectorRoot",
      tabIndex: -1,
      className: "lector-root",
      onError,
      loader: createElement("div", { className: "lector-loading" }, "Loading PDF…"),
    },
    createElement(
      Pages,
      { className: "lector-pages" },
      createElement(
        Page,
        null,
        createElement(CanvasLayer, null),
        createElement(TextLayer, null),
      ),
    ),
  );
}

const roots = new WeakMap();

window.LectorPanel = {
  mount(container, url, { onError } = {}) {
    this.unmount(container);
    const root = createRoot(container);
    roots.set(container, root);
    root.render(createElement(Viewer, { url, onError }));
  },
  unmount(container) {
    const root = roots.get(container);
    if (root) {
      root.unmount();
      roots.delete(container);
    }
  },
};
