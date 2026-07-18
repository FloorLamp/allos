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
  // unpdf requires a PLAIN Uint8Array — and a Node Buffer, though it IS a Uint8Array
  // subclass, is rejected. Make a plain view over the same bytes (zero copy).
  const data =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pdf = await getDocumentProxy(data);
  // mergePages joins every page into one string.
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
