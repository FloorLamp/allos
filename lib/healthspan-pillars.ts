// Healthspan pillars (issue #161). PURE — no DB, no network. Assembles a small set
// of evidence-backed longevity PILLARS, each CONSUMING an already-merged pure
// computation rather than re-deriving it (the "one question, one computation"
// rule): VO2 Max percentile (#158 lib/fitness-norms), sleep regularity (#160
// lib/sleep-regularity), biological age (#157/#209 lib/bio-age), and the share of
// tracked biomarkers sitting in their curated OPTIMAL band (lib/reference-range).
//
// Deliberately PILLARS, not a composite score — there is no invented single
// number. A pillar HIDES when its data is absent (age/sex unset, no readings,
// child profile): buildPillars simply omits any input it isn't given, so a missing
// upstream (e.g. the not-yet-merged strength-standard pillar, #152) drops out with
// no special-casing — add a new pillar by adding one input branch.

import {
  formatPercentile,
  type FitnessAgeResult,
  type FitnessPercentile,
} from "./fitness-norms";
import { bioAgeDeltaPhrase, type BioAgeDelta } from "./bio-age";
import type { AppRoute } from "./hrefs";
import {
  strengthLevelLabel,
  strengthTone,
  type StrengthLevel,
} from "./strength-standards";
import { sriPresentation } from "./sleep-regularity";
import { rangeBadge, type RangeBadge } from "./reference-range";
import { convertToCanonical } from "./unit-conversions";
import type { CanonicalBiomarker, Sex } from "./types";

// ── Optimal-range hit rate ("31 of 38 markers optimal") ──────────────────────

export interface OptimalHitRate {
  optimal: number;
  total: number;
}

// One tracked biomarker's latest reading + its canonical ranges. `value_num`/unit
// are the stored (possibly non-canonical-unit) reading; `cb` is the joined
// canonical row (ranges + direction). Both come from the query seam.
export interface BiomarkerReading {
  value_num: number | null;
  unit: string | null;
  cb: CanonicalBiomarker | null | undefined;
}

// A reading carrying its display + canonical names, for the expanded Longevity
// breakdown (#1042 phase 4) — the canonical name feeds biomarkerViewHref.
export interface NamedBiomarkerReading extends BiomarkerReading {
  name: string;
  canonicalName: string | null;
}

// The ONE judgment both the pillar's hit-rate count and the Longevity page's
// per-marker breakdown consume: null = unjudgeable (no canonical row, value
// missing/unconvertible, or no curated band) and the marker is excluded from
// numerator AND denominator; otherwise the rangeBadge verdict (agreeing with the
// badges shown on every biomarker surface).
function judgeReading(
  r: BiomarkerReading,
  sex?: Sex | null,
  age?: number | null
): Exclude<RangeBadge, "unknown"> | null {
  if (r.value_num == null || !r.cb) return null;
  const v = convertToCanonical(r.value_num, r.unit, r.cb);
  if (v == null) return null;
  const badge = rangeBadge(v, r.cb, sex, age);
  return badge === "unknown" ? null : badge;
}

// The share of tracked biomarkers whose LATEST reading sits in its optimal band.
// A marker counts toward the denominator only when we can judge it — a curated
// range exists and the value converts to the canonical unit (rangeBadge !==
// "unknown"); the numerator is the "optimal" verdicts. Consumes rangeBadge (the
// existing pure judgment) so the count agrees with the badges shown elsewhere.
export function optimalRangeHitRate(
  readings: BiomarkerReading[],
  sex?: Sex | null,
  age?: number | null
): OptimalHitRate {
  let optimal = 0;
  let total = 0;
  for (const r of readings) {
    const badge = judgeReading(r, sex, age);
    if (badge == null) continue;
    total++;
    if (badge === "optimal") optimal++;
  }
  return { optimal, total };
}

// The per-marker breakdown behind the hit rate, for the Longevity page's expanded
// #biomarkers section. Same inputs, same judgeReading, so its row counts ALWAYS
// reconcile with optimalRangeHitRate for the same readings (pinned by a test) —
// the expanded view is a formatter over the pillar's own computation, never a
// second engine. Non-optimal rows sort first (they're the actionable ones).
export interface OptimalShareRow {
  name: string;
  canonicalName: string | null;
  badge: Exclude<RangeBadge, "unknown">;
}

export function optimalShareRows(
  readings: NamedBiomarkerReading[],
  sex?: Sex | null,
  age?: number | null
): OptimalShareRow[] {
  const rows: OptimalShareRow[] = [];
  for (const r of readings) {
    const badge = judgeReading(r, sex, age);
    if (badge == null) continue;
    rows.push({ name: r.name, canonicalName: r.canonicalName, badge });
  }
  return rows.sort((a, b) => {
    const aOpt = a.badge === "optimal" ? 1 : 0;
    const bOpt = b.badge === "optimal" ? 1 : 0;
    if (aOpt !== bOpt) return aOpt - bOpt;
    return a.name.localeCompare(b.name);
  });
}

// ── Pillars ──────────────────────────────────────────────────────────────────

export type PillarKey =
  "vo2max" | "strength" | "sleep-regularity" | "bio-age" | "optimal-biomarkers";

// Where each pillar's EXPANDED section lives on the Longevity page (#1042 phase
// 4). ONE map drives both the widget deep-links (pillar hrefs below) and the
// page's section anchors (lib/longevity.ts), so a compact pillar card always
// lands on the section that expands that same pillar — the two can't drift.
// vo2max and strength share the #fitness section (both are fitness standings
// expanded by the fitness-check read view).
export const PILLAR_ANCHOR: Record<PillarKey, string> = {
  "bio-age": "bio-age",
  vo2max: "fitness",
  strength: "fitness",
  "sleep-regularity": "sleep",
  "optimal-biomarkers": "biomarkers",
};

// The widget deep-link for a pillar: the Longevity page section that expands it —
// EXCEPT sleep-regularity, whose expanded home moved to the dedicated /sleep page
// (issue #1066). PILLAR_ANCHOR still maps sleep-regularity → "sleep" so the
// Longevity page keeps grouping the pillar into its own (compact) section; only
// the pillar CARD's deep-link repoints to /sleep.
export function pillarHref(key: PillarKey): AppRoute {
  if (key === "sleep-regularity") return "/sleep";
  return `/longevity#${PILLAR_ANCHOR[key]}`;
}

export type PillarTone = "good" | "warn" | "bad" | "neutral";

// The text twin of each tone's color (WCAG 1.4.1, issue #1220): a pillar's
// good/warn/bad judgment must never travel by COLOR ALONE, so every judging tone
// carries a short label that both pillar surfaces (the dashboard widget and the
// Longevity page's PillarStat) render as a visible badge next to the colored
// value — the ONE mapping (#221), so a new pillar or surface can't ship
// color-only again. `neutral` is deliberately null: it makes no judgment (its
// value renders in the plain text color), so there is nothing to label.
export const PILLAR_TONE_LABEL: Record<PillarTone, string | null> = {
  good: "Good",
  warn: "Fair",
  bad: "Poor",
  neutral: null,
};

export interface PillarTrend {
  direction: "up" | "down" | "flat";
  label: string;
}

export interface Pillar {
  key: PillarKey;
  label: string;
  // The headline number/phrase, derived directly from the source computation.
  value: string;
  detail: string;
  tone: PillarTone;
  trend: PillarTrend | null;
  // Deep-link to the pillar's detail surface.
  href: AppRoute;
}

// The inputs a caller (the query seam) supplies. Every field is OPTIONAL: an
// absent/null input means "no data for this pillar" and it's omitted from the
// output. This is the whole hiding mechanism — no separate visibility flags.
export interface PillarInputs {
  vo2?: {
    percentile: FitnessPercentile;
    fitnessAge?: FitnessAgeResult | null;
    trend?: PillarTrend | null;
  } | null;
  sleep?: { sri: number; trend?: PillarTrend | null } | null;
  bioAge?: { delta: BioAgeDelta; trend?: PillarTrend | null } | null;
  optimal?: OptimalHitRate | null;
  // The lifter's strongest standing across the core barbell lifts (#152). `lift`
  // is the lift that reached `level`; the headline formats over `level` only, so a
  // consistency test can pin the pillar value equals strengthLevelLabel(level).
  strength?: {
    level: StrengthLevel;
    lift: string;
    trend?: PillarTrend | null;
  } | null;
}

function vo2Tone(p: number): PillarTone {
  if (p >= 50) return "good";
  if (p >= 25) return "warn";
  return "bad";
}

function optimalTone(rate: OptimalHitRate): PillarTone {
  if (rate.total === 0) return "neutral";
  const frac = rate.optimal / rate.total;
  if (frac >= 0.8) return "good";
  if (frac >= 0.5) return "warn";
  return "bad";
}

function bioAgeTone(d: BioAgeDelta): PillarTone {
  if (d.direction === "younger") return "good";
  if (d.direction === "older") return "bad";
  return "neutral";
}

// Assemble the visible pillars from whatever inputs are present, in a stable
// order. Each pillar's headline is a direct formatting of its source computation,
// so a consistency test (#224) can pin that the pillar value equals the source
// value for the same fixture.
export function buildPillars(inputs: PillarInputs): Pillar[] {
  const pillars: Pillar[] = [];

  if (inputs.vo2) {
    const p = inputs.vo2.percentile.percentile;
    const fa = inputs.vo2.fitnessAge;
    pillars.push({
      key: "vo2max",
      label: "Cardiorespiratory fitness",
      value: formatPercentile(inputs.vo2.percentile),
      detail:
        fa != null
          ? `VO₂ Max · fitness age ${fa.fitnessAge}`
          : "VO₂ Max percentile for your age & sex",
      tone: vo2Tone(p),
      trend: inputs.vo2.trend ?? null,
      href: pillarHref("vo2max"),
    });
  }

  if (inputs.strength) {
    const level = inputs.strength.level;
    pillars.push({
      key: "strength",
      label: "Strength standard",
      value: strengthLevelLabel(level),
      detail: `${inputs.strength.lift} — for your bodyweight & sex`,
      // strengthTone returns good/warn/bad, all valid PillarTones.
      tone: strengthTone(level),
      trend: inputs.strength.trend ?? null,
      href: pillarHref("strength"),
    });
  }

  if (inputs.sleep) {
    const sri = sriPresentation(inputs.sleep.sri);
    pillars.push({
      key: "sleep-regularity",
      label: "Sleep regularity",
      value: sri.text,
      detail: "Consistency of your sleep–wake timing",
      tone: sri.tone,
      trend: inputs.sleep.trend ?? null,
      href: pillarHref("sleep-regularity"),
    });
  }

  if (inputs.bioAge) {
    pillars.push({
      key: "bio-age",
      label: "Biological age",
      value: bioAgeDeltaPhrase(inputs.bioAge.delta),
      detail: `PhenoAge ${inputs.bioAge.delta.bioAge.toFixed(
        1
      )} vs calendar ${inputs.bioAge.delta.chronoAge}`,
      tone: bioAgeTone(inputs.bioAge.delta),
      trend: inputs.bioAge.trend ?? null,
      href: pillarHref("bio-age"),
    });
  }

  if (inputs.optimal && inputs.optimal.total > 0) {
    pillars.push({
      key: "optimal-biomarkers",
      label: "Biomarkers optimal",
      value: `${inputs.optimal.optimal} of ${inputs.optimal.total}`,
      detail: "Tracked markers inside their optimal range",
      tone: optimalTone(inputs.optimal),
      trend: null,
      href: pillarHref("optimal-biomarkers"),
    });
  }

  return pillars;
}
