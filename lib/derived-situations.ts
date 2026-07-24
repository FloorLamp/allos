// Derived situations (issues #1292, #1298) — the pattern: a "situation" a
// situational supplement keys on (lib/situations.ts) that is COMPUTED from the
// profile's own data, never a manual chip and never a machine-written row in the
// `situations` table. The #558 discipline (workout-conditioned dueness keys on the
// PREDICTED training day: derived context, surfacing-paths-only, no user toggle)
// applied to two more contexts:
//
//   • Poor sleep (#1292) — DERIVED from last night's sleep vs baseline (the SAME
//     rough-night threshold coaching already evaluates), OR DECLARED (the Poor sleep
//     situation manually toggled, for no-wearable / self-report profiles). On-with-
//     override: a one-tap "Not today" suppresses the DERIVED contribution for that
//     date only; a declared activation is cleared by the normal chip toggle.
//   • Period (#1298) — DERIVED from a logged menses day (a period log covering today).
//     No override needed: the log IS the control (editing the log is the override).
//     A declared manual toggle remains a fallback for profiles that don't track cycles.
//
// This module is PURE (no DB) so every rule + formatter is unit-testable. The DB
// gathers live in lib/queries/derived-situations.ts; the shared rough-night threshold
// evaluation (measureRoughNight) is ALSO consumed by the coaching engine's rest
// recommendation, so a declared rough night reaches coaching too and the measured
// path stays byte-for-byte identical to the pre-extraction engine (the #221 "one
// computation" discipline — derive, never re-implement).

import type { SleepSignal, CoachingThresholds } from "./coaching/engine";
import {
  BUILTIN_POOR_SLEEP_SITUATION,
  sameSituation,
  type SituationOption,
} from "./situations";

// The built-in derived situations, name-keyed via sameSituation (no illness_type, no
// episodes). "Poor sleep" already ships as a SUGGESTED_SITUATION; "Period" is added to
// the option set ONLY when cycle tracking is relevant (the #1042 `cycle` bit).
export { BUILTIN_POOR_SLEEP_SITUATION };
export const BUILTIN_PERIOD_SITUATION = "Period";

// Add the built-in "Period" situation to a merged option set ONLY when cycle tracking
// is relevant for the profile (#1298 — the SAME #1042 `cycle` bit the nav gates on), so
// a user can key an iron/magnesium item to Period. Appended (suggestion-only, no
// illness_type) unless the profile already has a "Period" vocabulary row. A profile
// that doesn't track cycles never sees it. Pure; the option-building surfaces call it.
export function withPeriodOption(
  options: SituationOption[],
  cycleRelevant: boolean
): SituationOption[] {
  if (
    !cycleRelevant ||
    options.some((o) => sameSituation(o.name, BUILTIN_PERIOD_SITUATION))
  )
    return options;
  return [
    ...options,
    {
      name: BUILTIN_PERIOD_SITUATION,
      inVocabulary: false,
      illnessType: false,
    },
  ];
}

// The date-scoped suppression key for the poor-sleep "Not today" override (#1292).
// Stored on the shared findings-suppression bus (upcoming_dismissals) so it composes
// with "dismiss once, silence everywhere"; date-scoped so it only ever suppresses the
// DERIVED contribution for that one calendar day (the resolver checks today's key).
// The prefix is registered in lib/rule-finding-prefixes.ts so the write action's
// dedupeKeyHasKnownPrefix guard accepts it (the #448 registry discipline).
export const POOR_SLEEP_OVERRIDE_PREFIX = "poor-sleep-override:";

export function poorSleepOverrideKey(date: string): string {
  return `${POOR_SLEEP_OVERRIDE_PREFIX}${date}`;
}

// ---- Rough-night threshold evaluation (extracted from the coaching engine) ----

export interface RoughNightMeasure {
  // Last night at least the (variance-aware) deficit below the personal baseline.
  belowBaseline: boolean;
  // Last night below the absolute floor, regardless of baseline.
  belowFloor: boolean;
  // Either trigger fired — the night reads as "rough".
  fired: boolean;
}

// "Was last night rough?" from the measured signal alone — the EXACT threshold logic
// the coaching engine's rest-sleep trigger used inline (#1292 extraction). With a known
// personal night-to-night spread the deficit that counts as "poor" widens to at least
// `multiplier × spread`, so a variable sleeper needs a real drop; the absolute floor
// stays fixed. Pure; the engine and the poor-sleep context resolver both call THIS so
// they can never disagree about what a rough night is.
export function measureRoughNight(
  sleep: SleepSignal,
  th: CoachingThresholds
): RoughNightMeasure {
  const effDeficit =
    sleep.baselineSpreadMin != null && sleep.baselineSpreadMin > 0
      ? Math.max(
          th.sleepDeficitMin,
          th.variabilitySpreadMultiplier * sleep.baselineSpreadMin
        )
      : th.sleepDeficitMin;
  const belowBaseline =
    sleep.baselineMin > 0 &&
    sleep.lastNightMin <= sleep.baselineMin - effDeficit;
  const belowFloor = sleep.lastNightMin < th.sleepFloorMin;
  return { belowBaseline, belowFloor, fired: belowBaseline || belowFloor };
}

// ---- The unified poor-sleep verdict (#1292) --------------------------------------

// Which input the verdict is based on — so basis-aware copy never invents figures for a
// declared night ("you flagged a rough night") yet keeps the numbers for a measured one.
export type RoughNightBasis = "measured" | "declared";

export interface RoughNightVerdict {
  on: boolean;
  basis: RoughNightBasis | null;
  // Present only for the MEASURED basis — the numbers the state line formats.
  lastNightMin?: number;
  baselineMin?: number;
  belowBaseline?: boolean;
}

export interface RoughNightInput {
  // The measured signal, or null when no sleep has synced (missing data ⇒ OFF, never a
  // guess — the resolver upstream already date-checks the night against today).
  sleep: SleepSignal | null;
  thresholds: CoachingThresholds;
  // The Poor sleep situation is manually toggled on (self-report / no-wearable).
  declared: boolean;
  // The date-scoped "Not today" override is set for this date. Suppresses the DERIVED
  // (measured) contribution only — a declared activation is never touched by it.
  overridden: boolean;
}

// "Is poor-sleep context on?" = declared OR (measured AND not overridden). The USER
// WINS over the data: a declared rough night reports the declared basis even when the
// measured signal looks fine (duration isn't quality — a no-wearable self-report or
// "data says fine but I feel wrecked"). Missing data or no baseline ⇒ measured never
// fires ⇒ OFF unless declared. Pure.
export function roughNightVerdict(input: RoughNightInput): RoughNightVerdict {
  const { sleep, thresholds, declared, overridden } = input;
  if (declared) return { on: true, basis: "declared" };
  const measured = sleep ? measureRoughNight(sleep, thresholds) : null;
  if (measured?.fired && !overridden && sleep) {
    return {
      on: true,
      basis: "measured",
      lastNightMin: sleep.lastNightMin,
      baselineMin: sleep.baselineMin,
      belowBaseline: measured.belowBaseline,
    };
  }
  return { on: false, basis: null };
}

// ---- Period context (#1298) ------------------------------------------------------

export interface PeriodVerdict {
  on: boolean;
  basis: "logged" | "declared" | null;
}

// "Is Period context on today?" = today falls in a LOGGED period (the factual
// `coveringPeriod` from periodOnDate — a period log with a start covering today, an
// open one covering every day from its start) OR the Period situation is DECLARED
// (the manual fallback for profiles that don't track cycles). Factual logged state,
// not prediction — fully inside the cycles page's "informational only" contract
// (menses only; phase-level keying is deliberately deferred, #1298). Pure.
export function periodVerdict(input: {
  coversToday: boolean;
  declared: boolean;
}): PeriodVerdict {
  if (input.coversToday) return { on: true, basis: "logged" };
  if (input.declared) return { on: true, basis: "declared" };
  return { on: false, basis: null };
}

// ---- State-line formatters (the visible, non-toggleable lines) -------------------

// "5h 10m" from a minute count (rounded to the minute).
function hoursMinutes(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// "~2h" — the whole-hour gap, for the "under usual" clause.
function approxHours(min: number): string {
  return `~${Math.max(1, Math.round(min / 60))}h`;
}

// The poor-sleep state line for the bar + the check-in Context disclosure + the digest
// (ONE formatter so a Telegram-first user sees the same acknowledgment as the page,
// #662). Basis-aware: measured names the numbers, declared never invents them. Returns
// null when the context is off (nothing to surface). `itemCount` is the number of
// situational items keyed to Poor sleep now due — 0 renders no line (with no keyed
// items the context has nothing to surface; coaching's rest rec serves those users).
export function poorSleepStateLine(
  verdict: RoughNightVerdict,
  itemCount: number
): string | null {
  if (!verdict.on || itemCount <= 0) return null;
  const items = `${itemCount} sleep-support ${itemCount === 1 ? "item" : "items"} active today`;
  if (verdict.basis === "measured" && verdict.lastNightMin != null) {
    const detail =
      verdict.baselineMin != null && verdict.belowBaseline
        ? `${hoursMinutes(verdict.lastNightMin)}, ${approxHours(
            verdict.baselineMin - verdict.lastNightMin
          )} under usual`
        : hoursMinutes(verdict.lastNightMin);
    return `Rough night (${detail}) — ${items} (auto)`;
  }
  return `You flagged a rough night — ${items} (auto)`;
}

// The Period state line — "Period logged — 2 items active" (#1298). Logged basis names
// the log; the declared fallback reads "on". Null when off or no keyed items due.
export function periodStateLine(
  verdict: PeriodVerdict,
  itemCount: number
): string | null {
  if (!verdict.on || itemCount <= 0) return null;
  const items = `${itemCount} ${itemCount === 1 ? "item" : "items"} active`;
  return verdict.basis === "logged"
    ? `Period logged — ${items}`
    : `Period — ${items}`;
}
