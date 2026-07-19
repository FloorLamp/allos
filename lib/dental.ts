// Pure normalization + display + classification helpers for structured dental
// procedures (#705). No DB/network imports, so the Server Actions, the import
// persist path, the follow-up adapter, and the #704 safety check all share the same
// coercion + the same invasiveness verdict (the "one question, one computation"
// rule) and it unit-tests without a handle.
//
// Scope: nothing here charts teeth or interprets a diagnosis — it maps a stated
// status / tooth system onto our enums, formats what the record already said, and
// answers ONE clinical-adjacent question the downstream consumers need: is a
// procedure INVASIVE (bone-manipulating / bleeding-prone), so #704's MRONJ /
// prophylaxis / anticoagulant checks gate on it and a routine cleaning triggers
// nothing. Dental X-rays are imaging studies (#702), not modeled here.

import type { DentalStatus, ToothSystem } from "./types/medical";

export const DENTAL_STATUSES: readonly DentalStatus[] = [
  "completed",
  "planned",
  "watch",
];

export const TOOTH_SYSTEMS: readonly ToothSystem[] = [
  "universal",
  "fdi",
  "palmer",
];

// Normalize a stated status onto the enum. Unknown / absent → 'completed' (the safe
// default: a recorded procedure is history unless flagged planned/watch).
export function normalizeDentalStatus(raw: unknown): DentalStatus {
  if (typeof raw !== "string") return "completed";
  const s = raw.trim().toLowerCase();
  if (!s) return "completed";
  if (
    s.startsWith("plan") ||
    s.includes("recommend") ||
    s.includes("proposed") ||
    s.includes("treatment plan") ||
    s === "tx plan"
  )
    return "planned";
  if (
    s.startsWith("watch") ||
    s.includes("monitor") ||
    s.includes("observe") ||
    s.includes("keep an eye") ||
    s.includes("recheck") ||
    s.includes("re-eval") ||
    s.includes("reeval")
  )
    return "watch";
  return "completed";
}

// Normalize a stated tooth-numbering system onto the enum, or null when unstated.
export function normalizeToothSystem(raw: unknown): ToothSystem | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("universal") || s === "ada") return "universal";
  if (s.includes("fdi") || s.includes("iso")) return "fdi";
  if (s.includes("palmer")) return "palmer";
  return null;
}

// Normalize a tooth designation to a trimmed token or null. Kept as free text (a
// tooth can be "14", "#14", "UL6", "A" for a primary tooth) — the numbering SYSTEM
// is captured separately; this only tidies whitespace and drops empties.
export function normalizeTooth(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s.length > 0 ? s : null;
}

// Normalize a surface designation ("MOD", "buccal", "O") to an uppercased trimmed
// token or null. Surface codes are conventionally uppercase single letters
// (M/O/D/B/L/I) or their concatenation; a spelled-out surface is left as typed but
// trimmed.
export function normalizeSurface(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  // A short all-letters code (≤4 chars, e.g. "MOD", "BL") is a surface abbreviation
  // → uppercase it; a longer word ("mesial") stays as typed.
  return s.length <= 4 && /^[a-z]+$/i.test(s) ? s.toUpperCase() : s;
}

// The label for a status badge.
export function dentalStatusLabel(status: DentalStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "planned":
      return "Planned";
    case "watch":
      return "Watch";
  }
}

// The compact tooth label ("#14 MOD", "#14"), or "" when not tooth-specific.
export function toothLabel(p: {
  tooth: string | null;
  surface: string | null;
}): string {
  const tooth = p.tooth?.trim();
  if (!tooth) return "";
  const num = /^#/.test(tooth) ? tooth : `#${tooth}`;
  const surface = p.surface?.trim();
  return surface ? `${num} ${surface}` : num;
}

// The one-line identity a dental record shows in a list / tab / passport: the
// procedure/finding name, then the tooth when tooth-specific — e.g. "Composite
// filling · #14 MOD", "Caries watch · #30", "Prophylaxis". Purely factual.
export function dentalDisplayLabel(p: {
  name: string;
  tooth: string | null;
  surface: string | null;
}): string {
  const name = p.name?.trim() || "Dental procedure";
  const tooth = toothLabel(p);
  return tooth ? `${name} · ${tooth}` : name;
}

// ── Invasiveness (#704 gate; #705 planned-procedure signal) ──────────────────
//
// Whether a dental procedure is INVASIVE — bone-manipulating or bleeding-prone —
// the ONE gate #704's MRONJ / antibiotic-prophylaxis / anticoagulant-bleeding
// checks fire on (a routine prophylaxis/cleaning, exam, radiograph, fluoride,
// sealant, or a simple filling/crown is NOT invasive and triggers nothing). Two
// signals, either sufficient:
//   • the procedure NAME names an invasive act (extraction, implant, surgical perio,
//     apicoectomy, biopsy, bone graft, alveoloplasty), OR
//   • the CDT/ADA code falls in a surgical category: oral & maxillofacial surgery
//     (D7xxx, includes extractions), surgical implant placement (D6010–D6199),
//     periodontal surgery (D4210–D4286, gingivectomy/flap/osseous), or apical
//     surgery (D3410–D3473).
// Source: American Dental Association CDT code categories; AAOMS/AAOM MRONJ position
// papers name extraction/implant/bony surgery as the invasive triggers; scaling &
// root planing and routine restorative work are excluded as non-invasive here.
//
// Deliberately conservative on the NON-invasive side so the check under-fires rather
// than over-fires (absence of a flag is not clearance — #704 §3): an unrecognized
// procedure returns false.

const INVASIVE_NAME_PATTERNS: readonly RegExp[] = [
  /\bextract/i, // extraction, extract
  /\btooth removal\b/i,
  /\bremoval of (?:tooth|teeth)\b/i,
  /\bimplant\b/i,
  /\bsurg/i, // surgery, surgical
  /\bosseous\b/i,
  /\bgingivectomy\b/i,
  /\bflap\b/i,
  /\bapicoectomy\b/i,
  /\bapical (?:surgery|resection)\b/i,
  /\bbiopsy\b/i,
  /\bbone graft\b/i,
  /\balveoloplasty\b/i,
  /\bfrenectomy\b/i,
];

// CDT code → its numeric procedure number (D7140 → 7140), or null when not a CDT
// code. CDT codes are "D" + four digits (optionally lettered variants ignored here).
function cdtNumber(code: string | null | undefined): number | null {
  if (!code) return null;
  const m = /^\s*d?\s*(\d{4})\b/i.exec(code.trim());
  return m ? Number(m[1]) : null;
}

function cdtIsSurgical(num: number): boolean {
  // D7xxx: Oral & Maxillofacial Surgery (extractions, biopsies, bony surgery).
  if (num >= 7000 && num <= 7999) return true;
  // Surgical implant placement (the restorative D62xx bridge codes are excluded).
  if (num >= 6010 && num <= 6199) return true;
  // Periodontal SURGERY (gingivectomy/flap/osseous) — D4210–D4286. Excludes SRP
  // (D4341/D4342) and non-surgical maintenance, which are NOT in this band.
  if (num >= 4210 && num <= 4286) return true;
  // Apical surgery / apicoectomy — D3410–D3473 (routine root canals sit below 3400).
  if (num >= 3410 && num <= 3473) return true;
  return false;
}

export function isInvasiveDentalProcedure(
  name: string | null | undefined,
  cdtCode: string | null | undefined
): boolean {
  const n = (name ?? "").trim();
  if (n && INVASIVE_NAME_PATTERNS.some((re) => re.test(n))) return true;
  const num = cdtNumber(cdtCode);
  return num != null && cdtIsSurgical(num);
}
