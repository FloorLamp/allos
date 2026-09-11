// Per-test FRESHNESS POLICY for the guided Fitness check (issue #2025). PURE — no DB.
//
// The check used to mark every test stale off ONE `cadenceDays` value (the profile's
// retest cadence, default 180 in the model / 90 in the coaching nudge). That is the right
// clock for a PERFORMED PROTOCOL — a dead hang, a sit-and-reach, a 12-minute run are
// things you go and do on a cadence — and the wrong clock for a value your scale or watch
// re-measures whenever you step on it. A three-month-old resting heart rate is not "still
// current, no need to re-check"; it is simply an old number that happens to be inside a
// protocol-shaped window.
//
// So freshness is DECLARED per test here rather than inferred in a component (#2025's
// "no component-local freshness thresholds"). Every battery key must appear in the
// registry — `missingFreshnessPolicies` drives a completeness test that fails when a new
// test ships without a declaration, so the default is a DECISION and never an oversight.
//
// The verdict itself is the shared vocabulary in lib/freshness; this module only resolves
// WHICH interval applies.
//
// AND WHERE THE QUANTITY ALREADY HAS AN INTERVAL, IT DOES NOT RESOLVE ONE (#4242). Two of
// these battery tests are not fitness quantities at all — a body-fat percentage and a
// resting heart rate are the SAME numbers the Trends body-census cards and the dashboard's
// Latest-vitals card render, arriving from the same scale and the same wearable. Those
// surfaces have a declared presentation floor per quantity, and this registry used to
// state a second, different number for each: 60 days here against 45 there for body fat,
// 30 here against 14 there for resting HR. One reading, two answers to "is this current?",
// and a doctrine change reaching only one of them.
//
// So the floor is taken BY REFERENCE, the pattern `TREND_METRIC_PRESENTATION_FLOORS`
// already uses for blood pressure and resting HR: the quantity's floor is named, never
// restated. The trend-metric value wins because it is the one the quantity's own surfaces
// argue for — a 20-day-old resting HR is already labelled as not-current on the dashboard
// and on Trends, so the fitness check calling it current was the outlier, not the floor.

import { FITNESS_BATTERY, type FitnessTestDef } from "./fitness-battery";
import { TREND_METRIC_PRESENTATION_FLOORS } from "./trend-metric-freshness";
import type { TrendMetricSlug } from "./trend-metrics";

export type FitnessFreshnessPolicy =
  // Inherits the profile's own retest cadence — the right clock for a performed protocol,
  // and the documented default.
  | { kind: "profile-cadence" }
  // The quantity's already-declared PRESENTATION FLOOR, named by trend-metric slug and
  // read through `TREND_METRIC_PRESENTATION_FLOORS` — never copied as a number, so the
  // two registries cannot disagree about one quantity. `because` states why this test is
  // a shared quantity rather than a performed protocol.
  | { kind: "shared-floor"; slug: TrendMetricSlug; because: string }
  // A fixed clock this registry owns alone, for a continuously measurable value that NO
  // other surface declares a floor for. `because` is the stated reason the exception
  // exists; it is documentation, not copy. A test whose quantity DOES have a floor may
  // not use this kind — `fitnessFloorsNotShared` fails the build's census if it does.
  | { kind: "fixed-days"; days: number; because: string };

// The battery tests that measure a quantity the presentation-floor registries already
// cover, and the slug each one IS. Declared here once: the policies below read their
// floor through it and the census below reads it back, so even the correspondence is
// stated in a single place.
export const FITNESS_FLOOR_QUANTITIES: Record<string, TrendMetricSlug> = {
  bodyfat: "body-fat",
  restinghr: "resting-hr",
};

export const DEFAULT_FITNESS_FRESHNESS: FitnessFreshnessPolicy = {
  kind: "profile-cadence",
};

// Every battery test's declared policy. Most tests are protocols and inherit the profile
// cadence; the two exceptions are the `body`-tier values a scale or a wearable re-measures
// on its own, which no protocol cadence describes — and those two take the floor their
// quantity's own surfaces already declare rather than writing a second one here.
export const FITNESS_FRESHNESS: Record<string, FitnessFreshnessPolicy> = {
  // ── Performed protocols: the profile's retest cadence is the clock. ──
  vo2max: DEFAULT_FITNESS_FRESHNESS,
  hrr: DEFAULT_FITNESS_FRESHNESS,
  grip: DEFAULT_FITNESS_FRESHNESS,
  pushups: DEFAULT_FITNESS_FRESHNESS,
  chairstand: DEFAULT_FITNESS_FRESHNESS,
  armcurl: DEFAULT_FITNESS_FRESHNESS,
  biglift: DEFAULT_FITNESS_FRESHNESS,
  vo2step2min: DEFAULT_FITNESS_FRESHNESS,
  balance: DEFAULT_FITNESS_FRESHNESS,
  tug: DEFAULT_FITNESS_FRESHNESS,
  fourstage: DEFAULT_FITNESS_FRESHNESS,
  sitreach: DEFAULT_FITNESS_FRESHNESS,
  srt: DEFAULT_FITNESS_FRESHNESS,
  deadhang: DEFAULT_FITNESS_FRESHNESS,
  plank: DEFAULT_FITNESS_FRESHNESS,

  // ── Shared quantities: the floor is the one the quantity's own surfaces declare. ──
  bodyfat: {
    kind: "shared-floor",
    slug: FITNESS_FLOOR_QUANTITIES.bodyfat,
    because:
      "Body composition drifts continuously and any scale step-on re-measures it, so a stored value goes historical long before a protocol would come due — and it is the SAME number the body-census card renders, which already declares how old it may be.",
  },
  restinghr: {
    kind: "shared-floor",
    slug: FITNESS_FLOOR_QUANTITIES.restinghr,
    because:
      "A resting heart rate is a monitored vital, not a performed protocol — and it is the SAME number the Latest-vitals card and the Trends stream card render, so its floor is theirs rather than a second one written here.",
  },
};

// The declared policy for a test key. An UNDECLARED key falls back to the documented
// default rather than throwing — the completeness test below is what keeps the registry
// honest, so a runtime miss degrades to the previous behavior instead of a crash.
export function fitnessFreshnessPolicy(key: string): FitnessFreshnessPolicy {
  return FITNESS_FRESHNESS[key] ?? DEFAULT_FITNESS_FRESHNESS;
}

// The freshness interval (days) for a test, given the profile's retest cadence. The ONE
// place the per-test exception is applied, consumed by the check model — never by a
// component.
export function fitnessFreshnessDays(
  key: string,
  profileCadenceDays: number
): number {
  const policy = fitnessFreshnessPolicy(key);
  if (policy.kind === "fixed-days") return policy.days;
  if (policy.kind === "shared-floor")
    return TREND_METRIC_PRESENTATION_FLOORS[policy.slug].days;
  return profileCadenceDays;
}

// Battery keys with no declared policy. Empty is the invariant; the pure completeness test
// asserts it over the whole battery (both age variants), so adding a test without a
// freshness declaration fails CI rather than silently inheriting one.
export function missingFreshnessPolicies(
  battery: readonly FitnessTestDef[] = FITNESS_BATTERY
): string[] {
  return battery
    .map((t) => t.key)
    .filter((k) => !Object.prototype.hasOwnProperty.call(FITNESS_FRESHNESS, k));
}

// Shared quantities that DON'T take their floor by reference — a test that measures a
// quantity with a declared presentation floor but states a second number for it, which is
// exactly the drift #4242 closed. Empty by construction, and kept as a runtime census so
// the completeness test reads the way `missingFreshnessPolicies` does and a hand-edited
// registry cannot quietly re-introduce a second answer for one quantity.
//
// A future test genuinely needing a window its quantity's surfaces do not want is not
// forbidden — it is required to ARGUE it, by dropping the key out of
// FITNESS_FLOOR_QUANTITIES with the reason, rather than by restating a number in place.
export function fitnessFloorsNotShared(
  policies: Record<string, FitnessFreshnessPolicy> = FITNESS_FRESHNESS
): string[] {
  return Object.keys(FITNESS_FLOOR_QUANTITIES).filter((key) => {
    const policy = policies[key];
    return (
      policy?.kind !== "shared-floor" ||
      policy.slug !== FITNESS_FLOOR_QUANTITIES[key]
    );
  });
}
