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

import { FITNESS_BATTERY, type FitnessTestDef } from "./fitness-battery";

export type FitnessFreshnessPolicy =
  // Inherits the profile's own retest cadence — the right clock for a performed protocol,
  // and the documented default.
  | { kind: "profile-cadence" }
  // A shorter fixed clock, for a value that is continuously measurable rather than
  // performed. `because` is the stated reason the exception exists; it is documentation,
  // not copy.
  | { kind: "fixed-days"; days: number; because: string };

export const DEFAULT_FITNESS_FRESHNESS: FitnessFreshnessPolicy = {
  kind: "profile-cadence",
};

// Every battery test's declared policy. Most tests are protocols and inherit the profile
// cadence; the two exceptions are the `body`-tier values a scale or a wearable re-measures
// on its own, which no protocol cadence describes.
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

  // ── Continuously measurable values: a protocol cadence overstates their currency. ──
  bodyfat: {
    kind: "fixed-days",
    days: 60,
    because:
      "Body composition drifts continuously and any scale step-on re-measures it, so a stored value goes historical long before a protocol would come due.",
  },
  restinghr: {
    kind: "fixed-days",
    days: 30,
    because:
      "A resting heart rate is a monitored vital, not a performed protocol — a month-old reading is an old number, not today's.",
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
  return policy.kind === "fixed-days" ? policy.days : profileCadenceDays;
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
