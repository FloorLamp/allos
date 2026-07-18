// Fiber-adequacy — the ONE pure computation behind the /nutrition fiber-adequacy card
// and the coaching-tier fiber-adequacy finding (issue #976). The #767 protein pipeline
// re-instantiated, with one extra basis protein didn't need: SUPPLEMENTED fiber from the
// day's confirmed doses. No DB, no clock, no network — the DB gather (lib/queries/
// nutrition.ts → getFiberAdequacy) assembles the typed inputs and hands them here, so the
// card and the finding are formatters over the SAME result ("one question, one
// computation").
//
// Intake composition (fiberIntake):
//   - `tracked`      — an integration's fiber_g daily total (Health Connect
//                      dietary_fiber_grams → fiber_g). A measured FULL-DAY total that
//                      already includes any supplements taken, so it OVERRIDES the sum.
//   - `estimated`    — servings × per-serving fiber_g from the food-group catalog (the
//                      #976 fiber_g column, reused through estimatedFiberGrams). A FLOOR
//                      by construction — incidental fiber from untracked foods is
//                      invisible.
//   - `supplemented` — grams from the day's CONFIRMED doses (the adherence log — TAKEN,
//                      not scheduled; a skipped psyllium day never counts). Recognized by
//                      the fiber name-matcher below; the gram amount is parsed with the
//                      SAME lib/dri.ts parser the UL/RDA stack checker uses (never a
//                      second parser). A capsule/unknown-unit fiber dose is HONEST — it
//                      contributes 0 g and sets `unknownSupplement`, and the surface notes
//                      "fiber supplement taken (grams unknown)" rather than fabricating a
//                      figure.
// When there's no tracked reading, `estimated` and `supplemented` SUM. The sum is still a
// FLOOR (untracked foods stay invisible), so every non-tracked surface's copy says so.
// The `basis` names the composition, extending the #824 `combined` precedent:
//   `combined` (both parts) / `estimated` (foods only) / `supplemented` (doses only) /
//   `tracked` (a measured total).
//
// Target (fiberTarget): the DRI Adequate Intake bands (IOM 2005) by age + sex — a flat
// g/day figure, NOT mass-scaled (fiber's DRI isn't). The 14 g/1000 kcal basis exists but
// the app doesn't track calories eaten, so the flat DRI band is the honest choice.
// Informational, never prescriptive (the #578/#767 framing).

import type { Sex } from "./types";
import { foodGroupBySlug } from "./food-groups";
import { parseQuantity } from "./dri";

// ---- Intake: tracked OVERRIDES (estimated + supplemented) ------------------

export type FiberBasis = "tracked" | "combined" | "estimated" | "supplemented";

export interface FiberIntake {
  // Per-day grams. For every non-`tracked` basis this is a FLOOR (see module header).
  grams: number;
  basis: FiberBasis;
  // The two floor components that add to `grams` for a non-`tracked` basis (both 0 for a
  // `tracked` basis, whose measured total overrides the sum).
  estimatedGrams: number;
  supplementedGrams: number;
  // True when a CONFIRMED fiber supplement dose was taken but its grams couldn't be
  // quantified (a capsule/unknown-unit dose). It contributes 0 g to `grams`, but the flag
  // lets the surface note "a fiber supplement was taken (grams unknown)" honestly rather
  // than pretend the day had none.
  unknownSupplement: boolean;
}

// A group's summed servings, as the #579 rollup produces.
export interface FiberServing {
  slug: string;
  servings: number;
}

// Sum fiber grams over a set of food-group servings: servings × the catalog's per-serving
// fiber_g, skipping groups the catalog marks as non-fiber-bearing (animal foods, water,
// sweets, alcohol) and any retired/unknown slug. A FLOOR — untracked foods are invisible.
// Pure over the shared rollup so the estimate and the servings card agree. The fiber twin
// of estimatedProteinGrams (#767).
export function estimatedFiberGrams(servings: FiberServing[]): number {
  let grams = 0;
  for (const s of servings) {
    if (!(s.servings > 0)) continue;
    const g = foodGroupBySlug(s.slug)?.fiber_g;
    if (g != null) grams += s.servings * g;
  }
  return grams;
}

// ---- Fiber supplement recognition + dose-gram parsing ----------------------

// Supplement/medication NAME → "is this a fiber supplement?" — the fiber twin of
// lib/dri.ts NAME_MATCHERS, kept small and case-insensitive. Covers the common products
// the supplement catalog ships (psyllium husk, generic "Fiber", methylcellulose, inulin,
// flaxseed) plus the household brands (Metamucil, Benefiber, wheat dextrin). Deliberately
// word-anchored so it does NOT match unrelated products — "fish oil" must never read as
// fiber (the `\bfiber\b` alternative can't match "fish").
const FIBER_NAME_MATCHERS: RegExp[] = [
  /psyllium/i,
  /methylcellulose/i,
  /\binulin\b/i,
  /flax\s*seed|flaxseed|ground\s*flax/i,
  /metamucil/i,
  /benefiber/i,
  /wheat\s*dextrin/i,
  /\bfiber\b/i,
];

// Whether an intake item's name reads as a fiber supplement (see FIBER_NAME_MATCHERS).
export function isFiberSupplement(name: string): boolean {
  return FIBER_NAME_MATCHERS.some((re) => re.test(name));
}

export interface FiberDoseGrams {
  // The parsed gram amount (0 when the dose isn't quantified in grams).
  grams: number;
  // True when a gram amount was parsed; false for a non-gram/unknown-unit dose (a
  // capsule, a scoop, an mg/IU amount, or an unparseable string) — honestly unknown.
  known: boolean;
}

// The fiber grams a single CONFIRMED dose contributes. Reuses the lib/dri.ts parser
// (never a second parser) and honors ONLY gram amounts — fiber is dosed in grams
// ("5 g", "10 g"), so an mg/IU/capsule/null amount is honestly unknown (0 g, known
// false). A "5 g" psyllium scoop → { grams: 5, known: true }; "1 capsule" → { grams: 0,
// known: false }.
export function fiberDoseGrams(amount: string | null): FiberDoseGrams {
  const q = parseQuantity(amount);
  if (q && q.unit === "g" && q.value > 0) return { grams: q.value, known: true };
  return { grams: 0, known: false };
}

// Compose the intake (issue #976): a measured `tracked` reading OVERRIDES; otherwise the
// estimated food-group floor and the supplemented dose grams SUM. Each input is an
// already-per-day figure the gather computed (an average over the days that carry it).
// Returns null when no basis has any signal AND no unknown-grams fiber supplement was
// taken — a lone unknown-unit dose still surfaces (grams 0) so the honest note renders.
export function fiberIntake(args: {
  dailyTracked: number | null;
  dailyEstimated: number;
  dailySupplemented?: number | null;
  unknownSupplement?: boolean;
}): FiberIntake | null {
  const unknownSupplement = !!args.unknownSupplement;
  if (args.dailyTracked != null && args.dailyTracked > 0)
    return {
      grams: args.dailyTracked,
      basis: "tracked",
      estimatedGrams: 0,
      supplementedGrams: 0,
      // A measured total already includes what was taken — the unknown-grams caveat is
      // moot on a tracked basis.
      unknownSupplement: false,
    };
  const estimated = args.dailyEstimated > 0 ? args.dailyEstimated : 0;
  const supplemented =
    args.dailySupplemented != null && args.dailySupplemented > 0
      ? args.dailySupplemented
      : 0;
  const grams = estimated + supplemented;
  if (grams <= 0 && !unknownSupplement) return null;
  const basis: FiberBasis =
    estimated > 0 && supplemented > 0
      ? "combined"
      : supplemented > 0
        ? "supplemented"
        : estimated > 0
          ? "estimated"
          : // grams 0 but an unknown-unit fiber dose was taken — a supplement day whose
            // amount we can't quantify.
            "supplemented";
  return {
    grams,
    basis,
    estimatedGrams: estimated,
    supplementedGrams: supplemented,
    unknownSupplement,
  };
}

// ---- Target: DRI Adequate Intake bands (age + sex) → g/day -----------------

export interface FiberTarget {
  // The DRI Adequate Intake for the profile's age/sex (g/day) — the band floor.
  grams: number;
  // A soft "very high" ceiling (informational; fiber above it is a GI-comfort note, never
  // an alarm). `above` only past this.
  gramsHigh: number;
  sex: Sex | null;
  ageYears: number | null;
  // A short human phrase naming the band basis, e.g. "adult male" / "adult".
  basisLabel: string;
}

// DRI Adequate Intake for total fiber (IOM 2005, "Dietary Reference Intakes for Energy,
// Carbohydrate, Fiber, Fat, Fatty Acids, Cholesterol, Protein, and Amino Acids"). g/day
// by half-open [minAge, maxAge) band and sex. Adult values are the headline figures the
// issue names (25 g female / 38 g male, dropping to 21/30 at 51+).
const FIBER_AI_BANDS: {
  minAge: number;
  maxAge: number | null;
  male: number;
  female: number;
}[] = [
  { minAge: 1, maxAge: 4, male: 19, female: 19 },
  { minAge: 4, maxAge: 9, male: 25, female: 25 },
  { minAge: 9, maxAge: 14, male: 31, female: 26 },
  { minAge: 14, maxAge: 19, male: 38, female: 26 },
  { minAge: 19, maxAge: 51, male: 38, female: 25 },
  { minAge: 51, maxAge: null, male: 30, female: 21 },
];

// When age is unknown, score against a default ADULT age (the app's common case — a
// tracking adult who hasn't entered a birthdate). Mirrors lib/dri.ts DEFAULT_ADULT_AGE.
const DEFAULT_ADULT_AGE = 30;

function round(n: number): number {
  return Math.round(n);
}

// The DRI fiber Adequate-Intake band for age + sex. Prefers the sex-specific figure; with
// sex unknown, uses the midpoint of the male/female values for the age band (an honest
// neutral target, not a guess at sex). Returns null only below the youngest band (an
// infant < 1 y — fiber goals don't apply). Never prescriptive.
export function fiberTarget(args: {
  ageYears: number | null;
  sex: Sex | null;
}): FiberTarget | null {
  const age = args.ageYears ?? DEFAULT_ADULT_AGE;
  const band = FIBER_AI_BANDS.find(
    (b) => age >= b.minAge && (b.maxAge == null || age < b.maxAge)
  );
  if (!band) return null;
  const grams =
    args.sex === "male"
      ? band.male
      : args.sex === "female"
        ? band.female
        : round((band.male + band.female) / 2);
  const isAdult = age >= 19;
  const basisLabel = args.sex
    ? `${isAdult ? "adult " : ""}${args.sex}`
    : isAdult
      ? "adult"
      : "age-based";
  return {
    grams,
    // Soft excess ceiling: 1.6× the AI, rounded. Fiber above this is a GI-comfort note,
    // never a shortfall or an alarm.
    gramsHigh: round(grams * 1.6),
    sex: args.sex,
    ageYears: args.ageYears,
    basisLabel,
  };
}

// ---- Adequacy: intake vs target -------------------------------------------

export type FiberAdequacyStatus = "below" | "within" | "above";

export interface FiberAdequacy {
  intake: FiberIntake;
  target: FiberTarget;
  status: FiberAdequacyStatus;
}

// Combine intake + target into an adequacy verdict, or null when either is missing.
// `below` = under the AI, `above` = over the soft ceiling (a non-event for fiber short of
// GI copy — kept neutral), else `within`. For a non-`tracked` basis a `below` is NOT a
// definite shortfall (the intake is a floor) — the wording, not this status, carries that
// caveat (mirroring the protein/#578 split).
export function assessFiberAdequacy(
  intake: FiberIntake | null,
  target: FiberTarget | null
): FiberAdequacy | null {
  if (!intake || !target) return null;
  const status: FiberAdequacyStatus =
    intake.grams < target.grams
      ? "below"
      : intake.grams > target.gramsHigh
        ? "above"
        : "within";
  return { intake, target, status };
}

// ---- Finding identity + formatting (shared by every surface) ---------------

// The findings-bus namespace for the fiber-adequacy coaching observation. One stable key
// per profile (the subject is "am I hitting my fiber target?"), so a dismiss follows the
// topic. Registered in RULE_FINDING_PREFIXES so a page's prefix guard can match it.
export const FIBER_ADEQUACY_PREFIX = "fiber-adequacy:";

export function fiberAdequacySignalKey(): string {
  return `${FIBER_ADEQUACY_PREFIX}shortfall`;
}

// Round a fiber figure for display (whole grams).
function g(n: number): string {
  return String(Math.round(n));
}

// The "a floor — actual likely higher" caveat that every non-tracked basis carries.
const FLOOR_CAVEAT = "a floor — actual likely higher";

// The honest note for a confirmed-but-unquantified fiber supplement dose (a capsule /
// unknown-unit product). Appended to the intake copy so the surface never fabricates a
// gram figure it doesn't have.
export const UNKNOWN_SUPPLEMENT_NOTE =
  "a fiber supplement was taken (grams unknown)";

// The intake summary line. Only `tracked` reads as a measured total; every other basis
// carries the floor caveat, and `combined` names the composition. The unknown-supplement
// note is appended whenever a confirmed fiber dose couldn't be quantified.
export function fiberIntakeSummary(intake: FiberIntake): string {
  const unknown = intake.unknownSupplement ? ` — ${UNKNOWN_SUPPLEMENT_NOTE}` : "";
  switch (intake.basis) {
    case "tracked":
      return `~${g(intake.grams)} g/day from your tracked intake`;
    case "combined":
      return `≈${g(intake.grams)} g/day — ${g(intake.estimatedGrams)} g estimated from foods + ${g(intake.supplementedGrams)} g from supplements (${FLOOR_CAVEAT})${unknown}`;
    case "supplemented":
      return intake.grams > 0
        ? `≈${g(intake.grams)} g/day from fiber supplements (${FLOOR_CAVEAT})${unknown}`
        : `Fiber logged only from supplements${unknown ? ` — ${UNKNOWN_SUPPLEMENT_NOTE}` : ""}`;
    case "estimated":
      return `≈${g(intake.grams)} g/day from logged foods (${FLOOR_CAVEAT})${unknown}`;
  }
}

// The target band line. e.g. "~38 g/day (DRI adequate intake, adult male)".
export function fiberTargetSummary(target: FiberTarget): string {
  return `~${g(target.grams)} g/day (DRI adequate intake, ${target.basisLabel})`;
}

export function fiberAdequacyTitle(a: FiberAdequacy): string {
  switch (a.status) {
    case "below":
      return "Fiber may be below the daily target";
    case "above":
      return "Fiber is above the usual range";
    case "within":
      return "Fiber is in the healthy range";
  }
}

// The informational, never-prescriptive detail. Every non-`tracked` basis is stated as a
// floor — the shortfall is NOT asserted, since untracked foods stay invisible; only a
// `tracked` measured total states the gap directly. Always closes with the informational
// framing.
export function fiberAdequacyDetail(a: FiberAdequacy): string {
  const intake = fiberIntakeSummary(a.intake);
  const target = fiberTargetSummary(a.target);
  const isFloor = a.intake.basis !== "tracked";
  let lead: string;
  if (a.status === "below") {
    lead = isFloor
      ? `Your intake is ${intake} — below the ${target}. Because that's a floor, your real intake may already be there; if it isn't, a little more fiber from whole plants helps.`
      : `Your fiber is ${intake} — below the ${target}. Nudging it up with whole plants helps.`;
  } else if (a.status === "above") {
    lead = `Your fiber is ${intake} — above the ${target}. That's fine for most people; ramp up slowly and drink water if it's new.`;
  } else {
    lead = `Your fiber is ${intake} — within the ${target}. Nice.`;
  }
  return `${lead} Informational, not medical or dietary advice.`;
}

// The evidence line: the DRI basis behind the band.
export function fiberAdequacyEvidence(a: FiberAdequacy): string {
  return `Target ~${Math.round(a.target.grams)} g/day from the DRI Adequate Intake for fiber (IOM 2005). Informational, not prescriptive.`;
}
