// Stands in for pdfjs-dist in the panel bundle (esbuild --alias), so the
// reader can show download progress: Lector keeps the loading task's
// onProgress to itself, so getDocument wraps that slot and also reports each
// event to the listeners added here.
import * as pdfjs from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";

export * from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";

const listeners = new Set();

/** Calls fn({ loaded, total }) as a document downloads; returns an unsubscribe. */
export function onDownloadProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDocument(params) {
  const task = pdfjs.getDocument(params);
  let handler = null;
  const report = (e) => {
    handler?.(e);
    for (const fn of listeners) fn(e);
  };
  Object.defineProperty(task, "onProgress", {
    configurable: true,
    get: () => report,
    set: (fn) => {
      handler = fn;
    },
  });
  return task;
}
