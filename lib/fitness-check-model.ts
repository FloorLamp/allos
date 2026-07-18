// Pure view model for the guided Fitness check (issue #834) — ONE computation the section
// component (and any future surface) formats over, so the completion %, per-domain
// percentile bars, and check-over-check deltas never drift ("one question, one
// computation", #221). DB-free: it takes the battery, the two most recent sessions, and
// the subject's sex/age/bodyweight, and returns a fully-derived model. Unit-tested in
// lib/__tests__.
//
// No new aggregate score (decided): the model exposes per-DOMAIN percentiles and per-test
// results; fitness age stays the one headline (surfaced from the endurance VO2 test here,
// but the app's canonical fitness age still lives in the healthspan pillars).

import {
  fitnessPercentile,
  fitnessAge,
  type FitnessPercentile,
  type FitnessAgeResult,
} from "@/lib/fitness-norms";
import { strengthBadge, type StrengthBadge } from "@/lib/strength-standards";
import type { Sex } from "@/lib/types";
import {
  type FitnessTestDef,
  type FitnessTier,
  type FitnessDomain,
} from "@/lib/fitness-battery";

// The minimal session shape the model needs (a subset of FitnessAssessmentRecord), so the
// model stays DB-free and testable with plain fixtures.
export interface AssessmentLike {
  date: string;
  entries: {
    testKey: string;
    value: number;
    rawInput?: unknown;
  }[];
}

export interface FitnessTestResult {
  key: string;
  label: string;
  tier: FitnessTier;
  domain: FitnessDomain;
  unit: string;
  measured: boolean;
  value: number | null;
  lowerIsBetter: boolean;
  // norms tier
  percentile: FitnessPercentile | null;
  fitnessAge: FitnessAgeResult | null;
  // standard tier
  standing: StrengthBadge | null;
  standingLift: string | null;
  // check-over-check
  delta: number | null; // signed value change vs the prior check (canonical unit)
  improved: boolean | null; // whether the delta is an improvement (direction-aware)
  interpretation?: string;
}

export interface FitnessDomainSummary {
  domain: FitnessDomain;
  percentile: number | null; // best measured norms percentile in the domain
  measuredCount: number;
  totalCount: number;
}

export interface FitnessCheckModel {
  latestDate: string | null;
  priorDate: string | null;
  measuredCount: number;
  totalCount: number;
  results: FitnessTestResult[];
  domains: FitnessDomainSummary[];
  headlineFitnessAge: FitnessAgeResult | null; // from the endurance VO2 test, when measured
}

// The domain display order for the per-domain bars.
const DOMAIN_ORDER: FitnessDomain[] = [
  "endurance",
  "strength",
  "balance",
  "flexibility",
  "mobility",
  "body",
];

function entryFor(a: AssessmentLike | null, key: string) {
  return a?.entries.find((e) => e.testKey === key) ?? null;
}

// Build the model for a battery + the latest/prior sessions + subject context.
export function buildFitnessCheckModel(
  battery: FitnessTestDef[],
  latest: AssessmentLike | null,
  prior: AssessmentLike | null,
  sex: Sex | null,
  age: number | null,
  bodyweightKg: number | null
): FitnessCheckModel {
  const results: FitnessTestResult[] = battery.map((def) => {
    const cur = entryFor(latest, def.key);
    const prev = entryFor(prior, def.key);
    const value = cur ? cur.value : null;
    const lowerIsBetter = !!def.lowerIsBetter;

    let percentile: FitnessPercentile | null = null;
    let fa: FitnessAgeResult | null = null;
    if (def.tier === "norms" && def.normsMarker && value != null) {
      percentile = fitnessPercentile(def.normsMarker, value, sex, age);
      fa = fitnessAge(def.normsMarker, value, sex, age);
    }

    let standing: StrengthBadge | null = null;
    let standingLift: string | null = null;
    if (def.tier === "standard" && value != null) {
      const lift =
        (cur?.rawInput as { lift?: string } | undefined)?.lift ?? null;
      if (lift) {
        standing = strengthBadge(lift, value, sex, bodyweightKg);
        standingLift = lift;
      }
    }

    let delta: number | null = null;
    let improved: boolean | null = null;
    if (value != null && prev != null) {
      delta = Math.round((value - prev.value) * 100) / 100;
      if (delta === 0) improved = null;
      else improved = lowerIsBetter ? delta < 0 : delta > 0;
    }

    return {
      key: def.key,
      label: def.label,
      tier: def.tier,
      domain: def.domain,
      unit: def.unit,
      measured: cur != null,
      value,
      lowerIsBetter,
      percentile,
      fitnessAge: fa,
      standing,
      standingLift,
      delta,
      improved,
      interpretation: def.interpretation,
    };
  });

  const measuredCount = results.filter((r) => r.measured).length;

  const domains: FitnessDomainSummary[] = DOMAIN_ORDER.filter((d) =>
    battery.some((t) => t.domain === d)
  ).map((domain) => {
    const inDomain = results.filter((r) => r.domain === domain);
    const pcts = inDomain
      .map((r) => r.percentile?.percentile)
      .filter((p): p is number => p != null);
    return {
      domain,
      percentile: pcts.length ? Math.max(...pcts) : null,
      measuredCount: inDomain.filter((r) => r.measured).length,
      totalCount: inDomain.length,
    };
  });

  const vo2 = results.find((r) => r.key === "vo2max");

  return {
    latestDate: latest?.date ?? null,
    priorDate: prior?.date ?? null,
    measuredCount,
    totalCount: battery.length,
    results,
    domains,
    headlineFitnessAge: vo2?.fitnessAge ?? null,
  };
}
