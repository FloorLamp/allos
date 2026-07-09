import type { AllergyStatus, MedicalFlag } from "./types";
import { isNonOptimal } from "./reference-range";

// Allergen-specific IgE → Allergies view (issue #179 follow-up). Allergen-specific
// IgE tests (RAST / ImmunoCAP — "Peanut IgE", "Cat Dander IgE Ab", "Dust Mite d1
// IgE") arrive as lab biomarkers in medical_records, NOT in the CCD Allergies
// section. A positive/elevated result indicates a sensitization to that allergen
// and should surface as an allergy. We derive this at READ TIME (no stored rows),
// so editing/deleting the underlying lab automatically updates the allergies view —
// mirroring how the passport merges flagged + starred biomarkers. Everything here
// is pure + unit-tested (no DB/network).

// Total serum IgE — a single whole-body measure, NOT an allergen sensitization —
// must be excluded. LOINC 19113-0 "IgE" is the canonical total-IgE code; the name
// forms below catch exports that omit the LOINC.
const TOTAL_IGE_LOINCS = new Set(["19113-0"]);
const TOTAL_IGE_NAMES = new Set([
  "ige",
  "immunoglobulin e",
  "ige total",
  "total ige",
  "ige, total",
  "immunoglobulin e (ige)",
  "serum ige",
]);

// Is this analyte name/loinc a *total* IgE (to exclude)?
export function isTotalIgE(name: string, loinc?: string | null): boolean {
  if (loinc && TOTAL_IGE_LOINCS.has(loinc.trim())) return true;
  const n = name.trim().toLowerCase().replace(/\s+/g, " ");
  return TOTAL_IGE_NAMES.has(n);
}

// Boilerplate stripped when extracting the allergen name from an IgE analyte.
const IGE_BOILERPLATE =
  /\b(ige|ig\s*e|immunoglobulin\s*e|ab|antibody|antibodies|rast|immunocap|serum|specific|allergen|qualitative|quantitative|level|test)\b/gi;

// Is this analyte an ALLERGEN-SPECIFIC IgE (a sensitization marker)? True when it
// mentions IgE (or is RAST/ImmunoCAP) AND names an allergen (i.e. leaves a
// non-empty token after boilerplate is stripped) — and is not total IgE.
export function isAllergenSpecificIgE(
  name: string,
  loinc?: string | null
): boolean {
  if (!name?.trim()) return false;
  if (isTotalIgE(name, loinc)) return false;
  const n = name.toLowerCase();
  const mentionsIge =
    /\big\s*e\b/.test(n) || /\brast\b/.test(n) || /\bimmunocap\b/.test(n);
  if (!mentionsIge) return false;
  return allergenFromIgEName(name) !== null;
}

// Extract the allergen name from an allergen-specific IgE analyte name, stripping
// the IgE/Ab/units boilerplate and any bracketed unit/system suffix. Returns null
// when nothing meaningful remains (e.g. bare "IgE"). Preserves the source casing
// of the surviving tokens ("Cat Dander", "Egg White").
export function allergenFromIgEName(name: string): string | null {
  let s = name;
  // Drop bracketed/parenthetical unit or property suffixes: "[Units/volume]",
  // "(IgE)", trailing ", Serum".
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  // A leading allergen code like "d1"/"f13"/"e5" (ImmunoCAP) is not the name —
  // drop a short letter+digits token when other words remain.
  s = s.replace(IGE_BOILERPLATE, " ");
  s = s.replace(/[,/]+/g, " ").replace(/\s+/g, " ").trim();
  // Remove a trailing/leading standalone ImmunoCAP code token (e.g. "d1").
  const tokens = s.split(" ").filter((t) => t && !/^[a-z]\d{1,3}$/i.test(t));
  const out = tokens.join(" ").trim();
  return out.length ? out : null;
}

// Parse a RAST/ImmunoCAP class (0–6) from a result value string. Accepts "Class
// 3", "3", "Class III"; returns null when no class is expressed.
export function rastClassFromValue(
  value: string | null | undefined,
  valueNum?: number | null
): number | null {
  const roman: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
  };
  if (value != null) {
    const v = value.trim().toLowerCase();
    const m = /\bclass\s*([0-6])\b/.exec(v);
    if (m) return Number(m[1]);
    const mr = /\bclass\s*(i|ii|iii|iv|v|vi)\b/.exec(v);
    if (mr) return roman[mr[1]] ?? null;
    // A bare integer 0–6 with no other digits reads as a class.
    if (/^[0-6]$/.test(v)) return Number(v);
  }
  if (
    valueNum != null &&
    Number.isInteger(valueNum) &&
    valueNum >= 0 &&
    valueNum <= 6
  ) {
    return valueNum;
  }
  return null;
}

// Is an allergen-specific IgE result POSITIVE (a sensitization)? True when the lab
// flagged it above range (high / abnormal / non-optimal-high), or an explicit RAST
// class ≥ 1 is present, or a textual "positive"/"detected". A below-threshold /
// negative / class-0 result is NOT a sensitization.
export function isSensitizedIgE(opts: {
  flag: MedicalFlag | null;
  value: string | null;
  valueNum: number | null;
}): boolean {
  const { flag, value, valueNum } = opts;
  if (flag === "high" || flag === "abnormal" || flag === "non-optimal-high")
    return true;
  const cls = rastClassFromValue(value, valueNum);
  if (cls != null) return cls >= 1;
  if (value) {
    const v = value.toLowerCase();
    if (
      /\b(positive|detected|reactive)\b/.test(v) &&
      !/\bnon-?reactive\b/.test(v)
    )
      return true;
  }
  // A flag that is merely non-optimal (directionless/low) is not a positive; and
  // no flag + no class = we can't assert a sensitization.
  if (isNonOptimal(flag) && flag === "non-optimal") return false;
  return false;
}

// ---- merge stored allergies + lab-derived sensitizations ----

// Normalized allergen key for dedup — lowercased, punctuation/dander/allergy
// boilerplate removed — so a documented "Peanut" allergy and a "Peanut IgE"
// sensitization collapse to one row.
export function allergenKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\ballergy\b|\bdander\b|\bextract\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface StoredAllergyInput {
  id: number;
  substance: string;
  reaction: string | null;
  severity: string | null;
  status: AllergyStatus;
  onsetDate: string | null;
  source: string | null;
  documentId: number | null;
}

export interface IgESensitizationInput {
  allergen: string; // extracted allergen name
  marker: string; // full analyte name
  value: string | null;
  valueNum: number | null;
  unit: string | null;
  rastClass: number | null;
  flag: MedicalFlag | null;
  date: string | null;
}

// A merged allergies-view row. `origin` distinguishes a clinically-documented
// allergy from a lab-only sensitization; `evidence` carries the corroborating IgE
// when present (shown as supporting detail on a documented allergy, or the sole
// basis for a lab-derived one).
export interface AllergyViewItem {
  key: string;
  substance: string;
  reaction: string | null;
  severity: string | null;
  status: AllergyStatus | null;
  onsetDate: string | null;
  documented: boolean;
  allergyId: number | null;
  origin: "documented" | "labs" | "both";
  evidence: IgESensitizationInput | null;
}

// Merge documented allergies with positive lab-derived IgE sensitizations,
// deduplicating by normalized allergen name. A documented allergy that also has a
// positive IgE keeps its clinical fields and gains the IgE as corroborating
// evidence (origin "both"); a sensitization with no documented allergy becomes a
// lab-only row (origin "labs"). Documented rows sort first, then by substance.
export function buildAllergiesView(
  stored: readonly StoredAllergyInput[],
  sensitizations: readonly IgESensitizationInput[]
): AllergyViewItem[] {
  const byKey = new Map<string, AllergyViewItem>();

  for (const a of stored) {
    const key = allergenKey(a.substance) || a.substance.toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) continue; // keep the first documented row for a substance
    byKey.set(key, {
      key,
      substance: a.substance,
      reaction: a.reaction,
      severity: a.severity,
      status: a.status,
      onsetDate: a.onsetDate,
      documented: true,
      allergyId: a.id,
      origin: "documented",
      evidence: null,
    });
  }

  for (const s of sensitizations) {
    const key = allergenKey(s.allergen) || s.allergen.toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      // Corroborate an existing documented allergy; prefer the strongest evidence.
      if (
        !existing.evidence ||
        (s.rastClass ?? -1) > (existing.evidence.rastClass ?? -1)
      ) {
        existing.evidence = s;
      }
      existing.origin = existing.documented ? "both" : "labs";
      continue;
    }
    byKey.set(key, {
      key,
      substance: s.allergen,
      reaction: null,
      severity: null,
      status: null,
      onsetDate: s.date,
      documented: false,
      allergyId: null,
      origin: "labs",
      evidence: s,
    });
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.documented !== b.documented) return a.documented ? -1 : 1;
    return a.substance.localeCompare(b.substance, undefined, {
      sensitivity: "base",
    });
  });
}
