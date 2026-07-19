// Scoped printing for pages that stack more than one print artifact (#1042
// phase 3: the Passport page carries BOTH the passport summary and the
// emergency card — two distinct print/share artifacts on one route).
//
// Mechanism: the print button stamps `data-print-scope="<region>"` on <html>,
// and the print stylesheet (app/globals.css) hides every OTHER
// `[data-print-region]` while that attribute is present — so "Print" on the
// passport controls prints only the passport, and "Print" in the emergency
// section prints only the card, exactly as the two pre-merge pages did. A plain
// browser Ctrl+P sets no scope and prints the whole page.
//
// The attribute is cleared both synchronously after window.print() returns
// (Chromium/Firefox block until the dialog closes) and on `afterprint` (covers
// engines where print() returns early) so a stale scope can never hide a region
// from a later unscoped print.

export type PrintRegion = "passport" | "emergency";

export function printRegion(region: PrintRegion): void {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const clear = () => root.removeAttribute("data-print-scope");
  root.setAttribute("data-print-scope", region);
  window.addEventListener("afterprint", clear, { once: true });
  try {
    window.print();
  } finally {
    clear();
  }
}
