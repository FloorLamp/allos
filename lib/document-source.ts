// Canonical wire format for rows projected from an uploaded medical document.
// Source-keyed stores use `document:<id>`; document_id-keyed stores may carry it
// alongside their FK. Keep encoding and parsing here so every domain agrees.
export const DOCUMENT_SOURCE_PREFIX = "document:";

export function documentSource(documentId: number): string {
  return `${DOCUMENT_SOURCE_PREFIX}${documentId}`;
}

export function documentSourceId(source: string): number | null {
  if (!source.startsWith(DOCUMENT_SOURCE_PREFIX)) return null;
  const parsed = Number(source.slice(DOCUMENT_SOURCE_PREFIX.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
