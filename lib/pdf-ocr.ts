// OCR fallback for reconciling against a SCANNED PDF — one with no text layer, so
// lib/pdf-text returns "" and reconciliation would otherwise have nothing to check.
// Each page is rasterized (unpdf/PDF.js via a native canvas) and read by Tesseract,
// then the merged text feeds the same reconcileResults.
//
// Heavy on purpose-limited: a native canvas rasterizer + a Tesseract WASM worker,
// roughly a second per page. So it is loaded LAZILY (dynamic import) and reached ONLY
// when the text layer is empty, is bounded by maxPages, and is best-effort — it
// returns "" on any failure rather than throwing, so a reconciliation problem can
// never fail an import. Measured ~97% row confirmation on a real 34-page scan.

import { getDocumentProxy, renderPageAsImage } from "unpdf";

const DEFAULT_MAX_PAGES = 40;

export async function ocrPdfText(
  buffer: Buffer | Uint8Array,
  maxPages = DEFAULT_MAX_PAGES
): Promise<string> {
  // PDF.js DETACHES the ArrayBuffer it is handed, so every call gets a fresh copy.
  const fresh = () => Uint8Array.from(buffer);
  const canvasImport = () => import("@napi-rs/canvas");
  let worker: Awaited<
    ReturnType<typeof import("tesseract.js").createWorker>
  > | null = null;
  try {
    const { createWorker } = await import("tesseract.js");
    const pdf = await getDocumentProxy(fresh());
    const pages = Math.min(pdf.numPages, maxPages);
    worker = await createWorker("eng");
    let text = "";
    for (let p = 1; p <= pages; p++) {
      const img = await renderPageAsImage(fresh(), p, {
        scale: 2,
        canvasImport,
      });
      const { data } = await worker.recognize(Buffer.from(img));
      text += "\n" + data.text;
    }
    return text;
  } catch {
    return "";
  } finally {
    await worker?.terminate();
  }
}
