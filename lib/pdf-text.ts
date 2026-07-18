// Deterministic PDF text-layer extraction, for reconciling an AI extraction against
// the source document (lib/medical-extract/reconcile). The AI import path sends the
// PDF to the model and trusts what comes back; pulling the report's OWN text lets us
// cross-check — a hallucinated value or a dropped row is caught without a second
// model call.
//
// Returns "" for a PDF with no text layer (a scanned image); reconciliation then
// simply cannot confirm anything rather than failing.

import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfText(
  buffer: Buffer | Uint8Array | ArrayBuffer
): Promise<string> {
  // unpdf wants a PLAIN Uint8Array (a Node Buffer, though a Uint8Array subclass, is
  // rejected). Pass a COPY, not a view: PDF.js DETACHES the ArrayBuffer it is handed,
  // so aliasing the caller's bytes would leave their buffer unusable for a subsequent
  // read (e.g. the OCR fallback in reconcileAgainstSource).
  const src = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const data = Uint8Array.from(src);
  const pdf = await getDocumentProxy(data);
  // mergePages joins every page into one string.
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
