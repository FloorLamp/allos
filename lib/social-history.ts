import type { Sex } from "./types";

// Pure, DB-free parsing/normalization for the CCD Social History section (issue
// #188): the patient's coded sex (Sex assigned at birth 76689-9 / Sex 46098-0)
// and the tobacco smoking status (72166-2). Kept here — free of any XML/DB — so
// the sex-code and smoking-status mappings are unit-testable in isolation, exactly
// like clinical-parse.ts does for allergies/problems. lib/cda.ts reads the coded
// <value> off each observation and hands the primitives to these.

// SNOMED CT sex findings a Social History <value> uses (the HL7 gender / birth-sex
// value sets instead carry a bare M / F, handled below).
const SNOMED_MALE = "248153007"; // Male (finding)
const SNOMED_FEMALE = "248152002"; // Female (finding)

// A CDA coded <value> reduced to its primitives (no @_-prefixed parser shapes), so
// the normalizers below stay pure and independently testable.
export interface CodedValue {
  code: string | null;
  codeSystem: string | null; // codeSystem OID
  displayName: string | null;
  nullFlavor: string | null;
}

// Map a Social History sex <value> to our two-state Sex, or null when it carries
// no usable sex (nullFlavor'd — e.g. a "Sex assigned at birth" recorded as UNK).
// Accepts the SNOMED findings (248153007/248152002), the HL7 AdministrativeGender /
// US Core birth-sex value set (a bare M/F), and falls back to the display text
// ("Male (finding)").
export function normalizeSocialSex(
  v: CodedValue | null | undefined
): Sex | null {
  if (!v || v.nullFlavor) return null;
  const code = (v.code ?? "").trim();
  const disp = (v.displayName ?? "").trim().toLowerCase();
  if (code === SNOMED_MALE) return "male";
  if (code === SNOMED_FEMALE) return "female";
  if (/^m$/i.test(code)) return "male";
  if (/^f$/i.test(code)) return "female";
  // Display fallback (check female first so "female" never matches a "male" prefix).
  if (/^female/.test(disp)) return "female";
  if (/^male/.test(disp)) return "male";
  return null;
}

// A tobacco smoking-status finding worth recording (the informative subset of the
// 72166-2 value set). `code` is the SNOMED code when present; `display` the label.
export interface SmokingStatus {
  code: string | null;
  display: string;
}

// Map a 72166-2 (Tobacco smoking status NHIS) <value> to a recordable RISK-FACTOR
// status, or null when it carries no problem-list signal. Dropped (→ null):
//   - a nullFlavor'd value;
//   - the "consumption unknown" / "never assessed" / "not asked" sentinels
//     (mirrors how clinical-parse drops a "no known allergies" statement);
//   - "Never smoker" (SNOMED 266919005 and its text forms) — the ABSENCE of a risk
//     factor is not a problem-list item, and rendered on /conditions + the passport
//     it reads as misleading amber clutter indistinguishable from a diagnosis.
// KEPT: the tobacco-EXPOSURE statuses that ARE legitimate risk factors — "Former
// smoker", "Current every day smoker", "Light tobacco smoker", … — with their
// coded display.
export function normalizeSmokingStatus(
  v: CodedValue | null | undefined
): SmokingStatus | null {
  if (!v || v.nullFlavor) return null;
  const code = (v.code ?? "").trim() || null;
  const display = (v.displayName ?? "").trim();
  if (!display && !code) return null;
  const lower = display.toLowerCase();
  // Non-signals. 266927001 = "Tobacco smoking consumption unknown";
  // 266919005 = "Never smoked tobacco" / "Never smoker".
  if (
    code === "266927001" ||
    code === "266919005" ||
    /\bunknown\b/.test(lower) ||
    /never\s+smok/.test(lower) ||
    /never\s+assessed/.test(lower) ||
    /not\s+asked/.test(lower)
  ) {
    return null;
  }
  return { code, display: display || `Smoking status ${code}` };
}

// Map a KEPT tobacco-exposure smoking status (the output of normalizeSmokingStatus,
// which already drops "never smoker") to the structured tri-state used by the
// smoking-history record (issue #83). Everything the CCD parser keeps is an ever-
// smoker, so this is only the former-vs-current split: the SNOMED "ex-smoker" code
// (8517006) and any "former"/"ex-smoker"/"stopped"/"quit" display read as `former`;
// every other kept exposure status (current every-day / some-day / light / heavy
// smoker) reads as `current`.
export function smokingStatusToStructured(
  s: SmokingStatus
): "former" | "current" {
  const code = (s.code ?? "").trim();
  const disp = (s.display ?? "").toLowerCase();
  if (code === "8517006") return "former";
  if (/\bformer\b|\bex[-\s]?smoker\b|stopped smoking|\bquit\b/.test(disp))
    return "former";
  return "current";
}

// Stable per-document dedup key for a smoking-status condition row — keyed on the
// SNOMED code (else the display), so a reprocess and the two documents of an XDM
// package collapse to one row. Namespaced apart from problem-list conditions.
export function smokingConditionExternalId(s: SmokingStatus): string {
  const id = (s.code ?? s.display).toLowerCase().replace(/\s+/g, " ").trim();
  return `ccda:social-smoking:${id}`;
}
