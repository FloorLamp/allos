// Reconcile an AI extraction against the source document's own text (#918 follow-up).
//
// The AI import path resolves identity and reads values from the model alone. This
// pass takes the report's deterministic text layer (lib/pdf-text) and checks each
// extracted result against it: the analyte's PRINTED name should appear in the text,
// and its value should appear near that name. It catches two failure modes a model
// can't self-report — a value the model transcribed wrong or invented, and a name it
// coined that never appears in the source — WITHOUT a second model call.
//
// Deliberately conservative: it VERIFIES, it doesn't rewrite. A verdict of
// "name_not_found" or "value_mismatch" is a flag for review, not an automatic edit,
// because a report's text layer can be imperfect (odd spacing, ligatures, a scanned
// page with no text at all → every row is simply unverifiable, not wrong).

export type ReconcileVerdict =
  | "confirmed" // name found in the text AND its value appears next to it
  | "value_mismatch" // name found, but the extracted value is not near it
  | "name_not_found"; // the printed name never appears in the source text

export interface ResultReconciliation {
  name: string;
  value: string | null;
  verdict: ReconcileVerdict;
}

export interface ReconcileReport {
  total: number;
  confirmed: number;
  valueMismatch: number;
  nameNotFound: number;
  // Fraction of rows whose value we could positively confirm in the source text.
  confirmedRate: number;
  items: ResultReconciliation[];
}

// Case-fold, strip everything but alphanumerics/./%-/space, and collapse runs of
// whitespace — so the model's spacing/punctuation doesn't have to match the PDF's.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.%/+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whether a value token occurs inside a window of source text. A numeric value must
// match as a whole number (so "4.8" is not found inside "14.80"); a non-numeric
// value (NEGATIVE, "A POSITIVE", NONE SEEN) matches as a substring.
function valueInWindow(
  window: string,
  value: string,
  valueNum: number | null
): boolean {
  const v = norm(value);
  if (!v) return true; // nothing to verify → name presence alone confirms
  const numeric = /^[+-]?\d+(\.\d+)?$/.test(v);
  if (!numeric) return window.includes(v);
  const candidates = new Set([v]);
  if (valueNum != null) candidates.add(String(valueNum));
  for (const c of candidates) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not preceded/followed by a digit or dot → a standalone number.
    if (new RegExp(`(?<![\\d.])${esc}(?![\\d.])`).test(window)) return true;
  }
  return false;
}

export interface ReconcileInput {
  name: string;
  value: string | null;
  value_num: number | null;
}

// Orchestrator: pull the source PDF's text and reconcile the extraction against it.
// Prefers the deterministic text LAYER; when that is empty (a scanned image) it falls
// back to OCR so an image-only report is still verifiable. Returns null when there is
// nothing to check — a non-PDF source, or a PDF that yields no text either way. The
// readers are dynamic-imported here (not at module top) so reconcileResults stays
// dependency-free and unit-testable, and the heavy OCR stack only loads for a scan.
export async function reconcileAgainstSource(
  buffer: Buffer | Uint8Array,
  mime: string,
  results: ReconcileInput[]
): Promise<ReconcileReport | null> {
  if (!/pdf/i.test(mime)) return null;
  let text = "";
  try {
    const { extractPdfText } = await import("../pdf-text");
    text = await extractPdfText(buffer);
  } catch {
    return null; // unreadable / encrypted PDF → can't reconcile, don't fail the import
  }
  if (!text.trim()) {
    // No text layer (scanned image): OCR the pages. Heavy + best-effort, so it is
    // loaded lazily and returns "" on failure rather than throwing.
    try {
      const { ocrPdfText } = await import("../pdf-ocr");
      text = await ocrPdfText(buffer);
    } catch {
      return null;
    }
  }
  if (!text.trim()) return null; // nothing to reconcile against
  return reconcileResults(text, results);
}

export function reconcileResults(
  pdfText: string,
  results: ReconcileInput[]
): ReconcileReport {
  const T = norm(pdfText);
  const items: ResultReconciliation[] = results.map((r) => {
    // A trailing "%" in the model's name is the report's UNIT column, not part of the
    // name ("NEUTROPHILS %") — drop it so the name matches the printed text.
    const nameN = norm(r.name).replace(/\s*%$/, "");
    if (!nameN)
      return { name: r.name, value: r.value, verdict: "name_not_found" };

    // A name can appear MANY times — as a panel title AND its result row, or once per
    // specimen (a "GLUCOSE" in the CMP and another in the urinalysis). Anchoring on
    // the first hit would check the wrong line, so scan EVERY occurrence and confirm
    // if the value sits next to any of them. The value is to the RIGHT on a lab line;
    // a 160-char window covers "NAME  value  flag  ref-range  unit".
    let found = false;
    let anyName = false;
    for (let i = T.indexOf(nameN); i >= 0; i = T.indexOf(nameN, i + 1)) {
      anyName = true;
      const window = T.slice(i + nameN.length, i + nameN.length + 160);
      if (valueInWindow(window, r.value ?? "", r.value_num)) {
        found = true;
        break;
      }
    }
    const verdict: ReconcileVerdict = !anyName
      ? "name_not_found"
      : found
        ? "confirmed"
        : "value_mismatch";
    return { name: r.name, value: r.value, verdict };
  });
  const confirmed = items.filter((i) => i.verdict === "confirmed").length;
  const valueMismatch = items.filter(
    (i) => i.verdict === "value_mismatch"
  ).length;
  const nameNotFound = items.filter(
    (i) => i.verdict === "name_not_found"
  ).length;
  return {
    total: items.length,
    confirmed,
    valueMismatch,
    nameNotFound,
    confirmedRate: items.length ? confirmed / items.length : 0,
    items,
  };
}
