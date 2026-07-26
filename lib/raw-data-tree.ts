// #1318 — the format sniff + collapsed-summary derivations behind RawDataViewer,
// kept PURE (no DOM) so the tree logic is unit-tested without a browser. The actual
// JSON.parse / DOMParser and rendering live in the client component
// (components/RawDataViewer.tsx); this module only decides the FORMAT, derives the
// human-readable collapsed summaries for the two node adapters (JSON values / XML
// elements), and owns the depth-default + size-guard thresholds — so one tree UI
// serves both formats and the fold/depth machinery isn't built twice (#221).

export type RawFormat = "json" | "xml" | "text";

// Char length above which the viewer starts fully collapsed (the size guard, #1318).
// Char count is a good-enough proxy for bytes for this UI decision.
export const LARGE_PAYLOAD_CHARS = 50_000;

// Branches deeper than this render collapsed by default, so a multi-MB payload
// paints instantly. Depth 0 = the root node.
export const DEFAULT_COLLAPSE_DEPTH = 2;

export function isLargePayload(text: string): boolean {
  return text.length > LARGE_PAYLOAD_CHARS;
}

// Sniff once (never throws): valid JSON → "json"; else a non-empty string whose
// trimmed form opens with "<" is an XML candidate → "xml" (the component's DOMParser
// makes the final call, falling back to text on a parsererror); everything else →
// "text".
export function sniffRawFormat(text: string): RawFormat {
  const trimmed = text.trim();
  if (!trimmed) return "text";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // not JSON — fall through
  }
  if (trimmed.startsWith("<")) return "xml";
  return "text";
}

// ---- download descriptor ----
//
// The viewer's save-to-file affordance. The button is FORMAT-AWARE rather than
// hardcoded to JSON, because this one component genuinely serves all three modes: a
// MyChart CCD/XDM raw is XML, an AI extraction is JSON, and anything unparseable is
// plain text (see the import page's Raw extraction block). A button that always said
// "Download JSON" would hand you a `.json` file containing XML — mislabeling the file
// on disk, where the extension is the only remaining clue about what it holds.
//
// Kept here (pure) rather than in the component so the extension/MIME/label mapping is
// unit-tested without a DOM, like the rest of the tree model.
export interface RawDownload {
  filename: string;
  mime: string;
  label: string;
}

const DOWNLOAD_BY_FORMAT: Record<
  RawFormat,
  { ext: string; mime: string; label: string }
> = {
  json: { ext: "json", mime: "application/json", label: "Download JSON" },
  xml: { ext: "xml", mime: "application/xml", label: "Download XML" },
  text: { ext: "txt", mime: "text/plain", label: "Download" },
};

// Strip anything that could break a Content-Disposition filename or escape a
// directory, and bound the length. A base name that sanitizes to nothing (or is
// omitted) falls back to a generic stem rather than producing a dotfile.
export const RAW_DOWNLOAD_FALLBACK_STEM = "raw-data";
const MAX_STEM_CHARS = 80;

export function sanitizeDownloadStem(base: string | undefined): string {
  const cleaned = (base ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_STEM_CHARS)
    // A trailing separator left behind by the slice would produce "name-.json".
    .replace(/[-._]+$/g, "");
  return cleaned || RAW_DOWNLOAD_FALLBACK_STEM;
}

// The filename, MIME type, and button label for saving a raw payload of `format`.
export function rawDownload(format: RawFormat, base?: string): RawDownload {
  const { ext, mime, label } = DOWNLOAD_BY_FORMAT[format];
  return { filename: `${sanitizeDownloadStem(base)}.${ext}`, mime, label };
}

export type JsonKind =
  "object" | "array" | "string" | "number" | "boolean" | "null";

export function jsonKind(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

// Objects and arrays are the foldable BRANCH nodes; everything else is a leaf.
export function isJsonBranch(value: unknown): boolean {
  const k = jsonKind(value);
  return k === "object" || k === "array";
}

// The label shown on a COLLAPSED JSON branch so you know what's inside without
// expanding: arrays → "items (N)" / "empty", objects → "N keys" / "empty".
export function jsonCollapsedSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "empty" : `items (${value.length})`;
  }
  if (value !== null && typeof value === "object") {
    const n = Object.keys(value as object).length;
    return n === 0 ? "empty" : `${n} ${n === 1 ? "key" : "keys"}`;
  }
  return "";
}

// The label shown on a COLLAPSED XML element — an adapter over the normalized shape
// the component derives from a DOM Element (so this stays DOM-free and testable),
// e.g. "3 attrs · 2 children".
export function xmlCollapsedSummary(node: {
  attributeCount: number;
  childCount: number;
}): string {
  const parts: string[] = [];
  if (node.attributeCount > 0) {
    parts.push(
      `${node.attributeCount} ${node.attributeCount === 1 ? "attr" : "attrs"}`
    );
  }
  if (node.childCount > 0) {
    parts.push(
      `${node.childCount} ${node.childCount === 1 ? "child" : "children"}`
    );
  }
  return parts.length ? parts.join(" · ") : "empty";
}

// Whether a branch at `depth` starts OPEN: depth-limited, and forced closed for a
// large payload (the size guard). Depth 0 = the root.
export function defaultBranchOpen(depth: number, large: boolean): boolean {
  if (large) return false;
  return depth < DEFAULT_COLLAPSE_DEPTH;
}
