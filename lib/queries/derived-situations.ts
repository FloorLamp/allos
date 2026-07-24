// The DB gather half of the derived-situations pattern (#1292 Poor sleep, #1298
// Period). The pure rules + formatters live in lib/derived-situations.ts; this module
// reads the profile-scoped inputs each rule needs and produces:
//
//   • the per-context VERDICTS (with basis) the visible state lines format over, and
//   • getEffectiveActiveSituations(profileId, date) — the profile's active-situation
//     NAME set WIDENED by any derived context that holds today, the ONE seam every
//     dueness surface (Supplements bar, Medications, check-in count, Upcoming, notify
//     tick, digest) unions in so a situational item keyed to Poor sleep / Period goes
//     due exactly while the derived context holds (surfacing-paths-only, #558/#1292).
//
// Derived context belongs to the profile's LOCAL calendar day (`date` is today in the
// profile's timezone, resolved by the caller): a "night" and a "logged period day" are
// both judged against that local date, never UTC (the per-profile-context trap). No
// `.prepare` here — every read delegates to an already profile-scoped reader — so the
// scoping guard is unaffected.

import { getSleepSignal } from "./coaching";
import { getFindingSuppressions } from "./upcoming/suppressions";
import { getSupplements } from "./intake/schedule";
import { getActiveSituations } from "../settings";
import { getNavRelevance } from "./nav-relevance";
import { listCyclePeriods } from "../cycle-store";
import { periodOnDate } from "../cycle";
import { DEFAULT_COACHING_THRESHOLDS } from "../coaching";
import { sameSituation } from "../situations";
import {
  roughNightVerdict,
  periodVerdict,
  poorSleepStateLine,
  periodStateLine,
  poorSleepOverrideKey,
  BUILTIN_POOR_SLEEP_SITUATION,
  BUILTIN_PERIOD_SITUATION,
  type RoughNightVerdict,
  type PeriodVerdict,
} from "../derived-situations";

// Whether a declared-situation NAME set contains a given built-in (name-keyed, #560).
function declared(active: readonly string[], name: string): boolean {
  return active.some((s) => sameSituation(s, name));
}

export interface DerivedSituations {
  // The poor-sleep verdict (declared OR measured-and-not-overridden). #1292.
  poorSleep: RoughNightVerdict;
  // The period verdict (logged menses day OR declared fallback). #1298. Null when cycle
  // tracking isn't relevant for the profile (the built-in Period situation never shows).
  period: PeriodVerdict | null;
  // The DERIVED situation names to union into the active set (only those turned on by
  // derivation, i.e. NOT already declared — a declared toggle is already in the set).
  derivedNames: Set<string>;
}

// Resolve every derived situation for the profile on `date` (its local calendar day).
export function resolveDerivedSituations(
  profileId: number,
  date: string
): DerivedSituations {
  const active = getActiveSituations(profileId);

  // ---- Poor sleep (#1292) ----
  // Missing data ⇒ getSleepSignal null ⇒ measured never fires ⇒ OFF unless declared
  // (the conservative missing-data-OFF posture). The override is a date-scoped
  // suppression row on the shared bus; only today's key is ever consulted, so a stale
  // yesterday override never touches today.
  const suppressions = getFindingSuppressions(profileId);
  const poorSleep = roughNightVerdict({
    sleep: getSleepSignal(profileId),
    thresholds: DEFAULT_COACHING_THRESHOLDS,
    declared: declared(active, BUILTIN_POOR_SLEEP_SITUATION),
    overridden: suppressions.has(poorSleepOverrideKey(date)),
  });

  // ---- Period (#1298) ----
  // Gated on the SAME cycle relevance bit the nav uses (#1042): a profile that doesn't
  // track cycles never sees the built-in Period situation. Derived = today covered by a
  // logged period (factual, non-predictive — periodOnDate); declared is the fallback.
  const cycleRelevant = getNavRelevance(profileId).cycle;
  const period: PeriodVerdict | null = cycleRelevant
    ? periodVerdict({
        coversToday: periodOnDate(listCyclePeriods(profileId), date) != null,
        declared: declared(active, BUILTIN_PERIOD_SITUATION),
      })
    : null;

  // Only the names turned on by DERIVATION (not already declared) need adding — a
  // declared toggle is already in getActiveSituations.
  const derivedNames = new Set<string>();
  if (poorSleep.on && poorSleep.basis === "measured")
    derivedNames.add(BUILTIN_POOR_SLEEP_SITUATION);
  if (period?.on && period.basis === "logged")
    derivedNames.add(BUILTIN_PERIOD_SITUATION);

  return { poorSleep, period, derivedNames };
}

// The number of active, non-PRN situational items keyed to `situation` (name-keyed,
// #560) — the count the state line acknowledges. When the derived context is on, these
// are exactly the items that just went due (isDueOn's situational branch).
function keyedItemCount(
  supps: readonly {
    active?: number | boolean;
    as_needed?: number;
    condition?: string;
    situation?: string | null;
  }[],
  situation: string
): number {
  return supps.filter(
    (s) =>
      (s.active ?? true) &&
      !s.as_needed &&
      s.condition === "situational" &&
      s.situation != null &&
      sameSituation(s.situation, situation)
  ).length;
}

export interface DerivedSituationLines {
  // The poor-sleep acknowledgment line, or null (off / no keyed items). #1292.
  poorSleep: string | null;
  // The period acknowledgment line, or null (off / not relevant / no keyed items). #1298.
  period: string | null;
  // Whether the poor-sleep line carries the one-tap "Not today" override affordance —
  // true ONLY when the context is DERIVED (measured), never for a declared toggle (that
  // is cleared by its chip). Folded in here so a consumer resolves ONCE (the dashboard
  // hot path, #221) instead of re-running the sleep/cycle reads for a separate lookup.
  poorSleepOverridable: boolean;
}

// The visible state lines for the derived contexts — the ONE computation the Supplements
// bar, the #1221 check-in Context disclosure, and the morning digest all format over, so
// a Telegram-first user sees the same acknowledgment as the page (#662/#221). Basis-aware
// via the pure formatters; null where the context is off or has no keyed items to surface.
// CHEAP EARLY-OUT: a profile with NO situational item keyed to Poor sleep / Period has
// nothing to surface, so we skip the sleep/cycle/suppression reads entirely — the common
// case, keeping the dashboard render this feeds free of derived-context I/O.
export function getDerivedSituationLines(
  profileId: number,
  date: string
): DerivedSituationLines {
  const supps = getSupplements(profileId);
  const poorSleepItems = keyedItemCount(supps, BUILTIN_POOR_SLEEP_SITUATION);
  const periodItems = keyedItemCount(supps, BUILTIN_PERIOD_SITUATION);
  if (poorSleepItems === 0 && periodItems === 0) {
    return { poorSleep: null, period: null, poorSleepOverridable: false };
  }
  const d = resolveDerivedSituations(profileId, date);
  return {
    poorSleep:
      poorSleepItems > 0
        ? poorSleepStateLine(d.poorSleep, poorSleepItems)
        : null,
    period:
      periodItems > 0 && d.period
        ? periodStateLine(d.period, periodItems)
        : null,
    poorSleepOverridable:
      poorSleepItems > 0 && d.poorSleep.on && d.poorSleep.basis === "measured",
  };
}

// The active-situation NAME set widened by today's derived context — the ONE set every
// dueness surface consumes so a Poor sleep / Period situational item goes due exactly
// while its derived context holds. Declared ∪ derived (idempotent — a declared toggle
// is already present). Replaces `new Set(getActiveSituations(profileId))` at the
// dueness-surfacing call sites.
export function getEffectiveActiveSituations(
  profileId: number,
  date: string
): Set<string> {
  const set = new Set(getActiveSituations(profileId));
  for (const name of resolveDerivedSituations(profileId, date).derivedNames)
    set.add(name);
  return set;
}
