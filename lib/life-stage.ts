// One age model, many surfaces (issue #494). The app used to carry FOUR decoupled
// age axes — a fixed-18 "minor" line (body-fat / Body layout / fitness norms /
// bio-age / PhenoAge), a fixed-13 BP-regime line, a 240-month (20 y) growth-chart
// ceiling, and the orthogonal admin `min_training_age` access knob — each with its
// own magic number and null-handling, which drifted (a 14-year-old was an adult for
// BP but a child everywhere else; eGFR had no pediatric floor while PhenoAge beside
// it did; the growth card demoted itself for 18–19-year-olds). This module is the
// SINGLE identity computation the biomarker-family (#482) and preventive concept-map
// patterns already prove: one pure `lifeStage(age)` classifier plus a small set of
// DOMAIN PREDICATES, so the clinically-legitimate different lines (BP at 13, growth
// to 20, adult-population models at 18) become NAMED, DOCUMENTED members of one model
// instead of scattered constants a new surface can silently re-invent.
//
// `min_training_age` stays OUT of this module on purpose: it is an admin access
// policy (does this instance let a young profile reach the training surfaces at
// all), not a life stage — it lives in lib/age-gate.ts. This module owns the
// CONTENT-FRAMING lines (adult fitness science vs child-appropriate presentation).
//
// NULL-AGE POLICY (documented once, here): `lifeStage(null)` is `null` — "unknown".
// Each predicate then states its own unknown-age default, and those defaults are
// POLICY, deliberately not uniform:
//   • Presentations that RESTRUCTURE the UI (Body-tab growth layout, body-fat
//     de-prioritization, BP regime) default UNKNOWN → adult — we never reshape a
//     page on missing data, only on a positive under-age match.
//   • Adult-population STATISTICAL models (fitness percentiles, bio-age/PhenoAge,
//     eGFR, strength standing) default UNKNOWN → hidden — we never present an
//     adult-validated number without a known adult age.

export type LifeStage =
  "infant" | "child" | "adolescent" | "adult" | "older-adult";

// ── Named boundaries (whole years) — the members of the one model ───────────────
// Every age cutoff in the codebase is one of these boundaries (or carries a
// justification comment where a surface needs month precision). `life-stage.test.ts`
// pins the domain constants (fitness ADULT_MIN_AGE, BP ADULT_BP_AGE, PhenoAge floor,
// the growth-chart ceiling) against these so they can't drift back apart.

// < 1 y — infant (head-circumference charts, WHO 0–24 mo curves live below here).
export const INFANT_MAX_AGE = 1;

// < 13 y — AAP uses percentile-based pediatric BP thresholds below this age and
// switches to adult static thresholds at/after it. The child→adolescent boundary.
export const PEDIATRIC_BP_MAX_AGE = 13;

// ≥ 18 y — the floor for ADULT-POPULATION statistical models: fitness-norm
// percentiles / fitness age (#158), Levine PhenoAge & the bio-age hero (#157/#209),
// CKD-EPI eGFR (#490), and the healthspan strength standing (#491). These are
// validated in adults only; below it they return nothing rather than a wrong number.
export const ADULT_MIN_AGE = 18;

// < 20 y (= 240 months) — the WHO/CDC growth-chart data ceiling and the Body-tab
// growth-led presentation line (#492). The Body tab reorders to height-first, drops
// body-fat, floats the growth-percentile card to the top, and offers the height/
// head-circ quick-add for anyone within growth-chart range. Converges the former
// split between the fixed-18 layout line and the 240-month chart ceiling onto the
// single line the charts actually span, so an 18–19-year-old keeps the growth-led
// view instead of an adult layout with a demoted trailing growth card.
export const GROWTH_CHART_MAX_AGE = 20;

// ≥ 65 y — older adult. A named member for completeness/future use; no surface
// gates on it yet.
export const OLDER_ADULT_MIN_AGE = 65;

function known(age: number | null | undefined): age is number {
  return age != null && Number.isFinite(age) && age >= 0;
}

// The profile's life stage from its age in whole years, or null when the age is
// unknown. The single classifier the domain predicates below are defined against.
export function lifeStage(age: number | null | undefined): LifeStage | null {
  if (!known(age)) return null;
  if (age < INFANT_MAX_AGE) return "infant";
  if (age < PEDIATRIC_BP_MAX_AGE) return "child";
  if (age < ADULT_MIN_AGE) return "adolescent";
  if (age < OLDER_ADULT_MIN_AGE) return "adult";
  return "older-adult";
}

// ── Domain predicates ───────────────────────────────────────────────────────────

// Adult-population statistical models (fitness norms, bio-age/PhenoAge, eGFR,
// strength standing). HIDES on unknown age — we never present an adult-validated
// number without a known adult age. (age ≥ 18). A type guard so a passing check
// narrows the age to a concrete number for the formula that follows.
export function isAdultForClinical(
  age: number | null | undefined
): age is number {
  return known(age) && age >= ADULT_MIN_AGE;
}

// Legal minor — the complement of the adult-clinical floor for a KNOWN age.
// (age < 18; unknown → false, treated as an adult like the presentations above)
export function isMinor(age: number | null | undefined): boolean {
  return known(age) && age < ADULT_MIN_AGE;
}

// The BP interpretation regime. AAP switches from pediatric percentiles to adult
// static thresholds at 13 y. Unknown age → adult regime (the conservative default
// the BP surfaces already use — an adult range never falsely flags a child low).
// (age ≥ 13, or unknown)
export function isAdultBpRegime(age: number | null | undefined): boolean {
  return !known(age) || age >= PEDIATRIC_BP_MAX_AGE;
}

// The Body-tab growth-led presentation: height-first chart order, body-fat
// de-prioritized, growth-percentile card floated to the top, height/head-circ
// quick-add offered. True when the profile is within WHO/CDC growth-chart range
// (< 20 y). Unknown age → false (adult layout, body-fat shown) — we don't
// restructure the tab on missing data. (age < 20)
export function isGrowthTracked(age: number | null | undefined): boolean {
  return known(age) && age < GROWTH_CHART_MAX_AGE;
}
