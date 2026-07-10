// Structured smoking history (issue #83) — the tri-state status plus the two
// quantitative facts the risk-gated screening rules need: pack-years (lung LDCT
// threshold) and the quit year (its recency window). Pure + DB-free so the parser,
// the resolver, and the two gating predicates are unit-tested in isolation; the DB
// boundary resolves the inputs (the structured record via lib/settings'
// profile_settings accessors, the imported-condition fallback via lib/queries) and
// hands the primitives here.
//
// SIMPLIFIED, informational only — NOT clinical advice. The gates paraphrase the
// USPSTF eligibility INPUTS (lung LDCT: ≥20 pack-years AND currently smoking or quit
// within 15 years; AAA: ever smoked) so a personal tracker can surface a reminder;
// they do not reproduce full clinical criteria or constitute a screening decision.

export type SmokingStatusValue = "never" | "former" | "current";

export function isSmokingStatusValue(v: unknown): v is SmokingStatusValue {
  return v === "never" || v === "former" || v === "current";
}

// A profile's stored structured record. A null status is "unknown / not recorded"
// — DISTINCT from "never" (the tri-state the rules engine needs, per #83: absence
// is ambiguous, so it is data, not a guess). pack-years / quit year are null when
// not recorded.
export interface SmokingHistory {
  status: SmokingStatusValue | null;
  packYears: number | null;
  quitYear: number | null;
}

export const EMPTY_SMOKING_HISTORY: SmokingHistory = {
  status: null,
  packYears: null,
  quitYear: null,
};

// Parse/validate the status primitive coming off the settings tier or a form. A
// blank / unrecognized value reads as null (unknown) — the form clears by
// submitting "".
export function parseSmokingStatus(
  v: string | null | undefined
): SmokingStatusValue | null {
  return isSmokingStatusValue(v) ? v : null;
}

// Pack-years: a non-negative number (cigarette exposure), kept to one decimal and
// clamped to a sane ceiling so a fat-fingered entry can't poison the gate. NaN /
// sub-zero / blank → null.
export function parsePackYears(
  v: string | number | null | undefined
): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n * 10) / 10, 200);
}

// Quit year: a 4-digit calendar year within a plausible window. Out-of-range /
// non-integer / blank → null. (The action bounds it further to ≤ this year.)
export function parseQuitYear(
  v: string | number | null | undefined
): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1900 || n > 2100) return null;
  return n;
}

// The effective smoking facts the assessor consumes, after combining the structured
// record with the imported-condition fallback. `everSmoked` is the AAA input; the
// status + pack-years + quit year drive the lung gate. `source` tags provenance for
// UI copy ("structured" = entered/seeded record, "imported" = condition-row
// fallback only, null = nothing on file).
export interface ResolvedSmoking {
  status: SmokingStatusValue | null;
  packYears: number | null;
  quitYear: number | null;
  everSmoked: boolean;
  source: "structured" | "imported" | null;
}

export const NO_SMOKING: ResolvedSmoking = {
  status: null,
  packYears: null,
  quitYear: null,
  everSmoked: false,
  source: null,
};

// Resolve the effective smoking facts (issue #83). The structured record WINS
// whenever it carries a status — so a manual correction always beats a stale import
// (including "never", which authoritatively clears an ever-smoker gate). Otherwise
// an imported social-history smoking condition means "ever smoked, details unknown"
// (partial gating: AAA fires, the lung rule prompts for pack-years). Otherwise
// nothing is known and both risk-gated rules stay inert.
export function resolveSmoking(
  structured: SmokingHistory | null,
  importedEverSmoker: boolean
): ResolvedSmoking {
  if (structured && structured.status != null) {
    return {
      status: structured.status,
      packYears: structured.packYears,
      quitYear: structured.quitYear,
      everSmoked: structured.status !== "never",
      source: "structured",
    };
  }
  if (importedEverSmoker) {
    return {
      status: null,
      packYears: null,
      quitYear: null,
      everSmoked: true,
      source: "imported",
    };
  }
  return NO_SMOKING;
}

// AAA screening gate (issue #83): the USPSTF one-time abdominal-aortic-aneurysm
// ultrasound targets men 65–75 who have EVER smoked. Sex/age are enforced by the
// catalog + assessor; this is only the smoking half. An imported ever-smoker (no
// further detail) still satisfies it.
export function everSmoked(r: ResolvedSmoking): boolean {
  return r.everSmoked;
}

// Lung LDCT eligibility gate (issue #83). Tri-state so an imported-only profile
// (ever-smoker, no pack-years) can be PROMPTED to complete the record rather than
// silently gated out:
//   "eligible"   — ≥20 pack-years AND (currently smoking OR quit within 15 years)
//   "ineligible" — never smoked, <20 pack-years, or quit > 15 years ago
//   "needs_info" — ever smoked but the pack-years (or a former smoker's quit year)
//                  are unknown, so eligibility can't be decided yet
export type LungGate = "eligible" | "ineligible" | "needs_info";

export const LUNG_MIN_PACK_YEARS = 20;
export const LUNG_QUIT_WINDOW_YEARS = 15;

export function lungScreeningGate(
  r: ResolvedSmoking,
  currentYear: number
): LungGate {
  if (!r.everSmoked) return "ineligible";
  if (r.packYears == null) return "needs_info";
  if (r.packYears < LUNG_MIN_PACK_YEARS) return "ineligible";
  // Recency: a current smoker always qualifies; a former smoker needs a quit year
  // within the window; an unknown-status ever-smoker with no quit year can't be
  // decided (prompt for it).
  if (r.status === "current") return "eligible";
  if (r.quitYear == null) return "needs_info";
  return currentYear - r.quitYear <= LUNG_QUIT_WINDOW_YEARS
    ? "eligible"
    : "ineligible";
}

// A short human label for a status, for UI copy. Unknown → "Not recorded".
export function smokingStatusLabel(v: SmokingStatusValue | null): string {
  switch (v) {
    case "never":
      return "Never smoked";
    case "former":
      return "Former smoker";
    case "current":
      return "Current smoker";
    default:
      return "Not recorded";
  }
}
