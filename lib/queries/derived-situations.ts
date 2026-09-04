// The DB gather half of the derived-situations pattern (#1292 Poor sleep, #1298
// Period). The pure rules + formatters live in lib/derived-situations.ts; this module
// reads the profile-scoped inputs each rule needs and produces:
//
//   • the per-context VERDICTS (with basis) the visible state lines format over, and
//   • getEffectiveActiveSituations(profileId, date) — the profile's active-situation
//     NAME set on `date`, WIDENED by any derived context that held that day: the ONE
//     seam every dueness surface (Supplements bar, Medications, check-in count,
//     Upcoming, notify tick, digest) unions in so a situational item keyed to Poor
//     sleep / Period goes due exactly while the derived context holds
//     (surfacing-paths-only, #558/#1292).
//
// EVERY DERIVED SOURCE IS DATED (#3993, owner ruling), each from its own record: a
// period log is a span periodOnDate reads for any day inside its horizon (#2613, which
// refuses the FUTURE, not the past); a weather spell is a fact in the cached series; a
// rough night is the night ENDING the day, against the baseline before it, through the
// threshold the coaching engine calls. The old ground for answering only about NOW —
// that derived context "cannot be dated" — was never true of any of the three.
//
// A RETROACTIVE VERDICT READS DATA AS STORED NOW, the caveat the ruling recorded rather
// than smoothed away: a night that syncs late changes the verdict for its day, as a dose
// logged late moves that day's adherence. It is why this re-derives from the record
// instead of replaying a stored answer.
//
// Derived context belongs to the profile's LOCAL calendar day (`date` is a day in the
// profile's timezone, resolved by the caller): a "night" and a "logged period day" are
// both judged against that local date, never UTC (the per-profile-context trap). No
// `.prepare` here — every read delegates to an already profile-scoped reader — so the
// scoping guard is unaffected.

import { sleepSignalResolver } from "./coaching";
import type { SleepSignal } from "../coaching";
import { today } from "../db";
import { situationsActiveOn, type SituationEvent } from "../trend-annotations";
import { getSituationEvents } from "../settings/profile-attrs";
import { tickCached } from "../tick-cache";
import { getFindingSuppressions } from "./upcoming/suppressions";
import { getIntakeItems } from "./intake/schedule";
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
import {
  weatherSituationFigure,
  weatherSituationStateLine,
  WEATHER_SITUATIONS,
  type WeatherSituationState,
} from "../weather-situations";
import { weatherSituationsResolver } from "./weather-situations";
import type { TemperatureUnit } from "../settings";
import type { IntakeObligation } from "../types";

// Whether a declared-situation NAME set contains a given built-in (name-keyed, #560).
function declared(active: ReadonlySet<string>, name: string): boolean {
  for (const s of active) if (sameSituation(s, name)) return true;
  return false;
}

export interface DerivedSituations {
  // The poor-sleep verdict (declared OR measured-and-not-overridden). #1292.
  poorSleep: RoughNightVerdict;
  // The period verdict (logged menses day OR declared fallback). #1298. Null when cycle
  // tracking isn't relevant for the profile (the built-in Period situation never shows).
  period: PeriodVerdict | null;
  // The weather situations holding today (#1726) — heatwave, cold snap, pressure swing,
  // high pollen, poor air quality. Empty when the profile has no home location, isn't
  // weather-relevant, or nothing qualifies. There is no declared/derived split here:
  // unlike sleep and period, weather has no self-report fallback — either the cached
  // series says the day qualified or the app has nothing to claim.
  weather: WeatherSituationState[];
  // The DERIVED situation names to union into the active set (only those turned on by
  // derivation, i.e. NOT already declared — a declared toggle is already in the set).
  // Dated: these are the names derivation turned on ON `date` (#3993).
  derivedNames: Set<string>;
}

// Resolve every derived situation for the profile on `date` (a day in its local calendar).
//
// The parameter is `date`, not `today` (#3993). Every verdict below is a statement about
// THAT DAY, read from the record the day left: the night that ended it, the period log
// that covered it, the cached weather series through it. The #2613 horizon is now passed
// as what it is — the profile's real today — so periodOnDate can refuse a future day
// instead of being handed the subject day as its own horizon, which is the arrangement
// that made the guard unable to fire.
//
// TICK-MEMOIZED (#2724), measured first on #2674's evidence standard. One digest gather
// reaches this resolver from FOUR unrelated callers (two getEffectiveActiveSituations
// dueness reads, getDerivedSituationLines, and the reported-burden gather), and unlike
// the bare suppression read #2674 declined to memoize, this call is heavy: ~1.7 ms per
// call against a seeded profile (mean 1746 µs, p50 1621 µs, n=5000 — the weather-series
// scan dominates), so the four collapse to one for ~5.2 ms per profile per digest gather
// (~5% of the ~97 ms gather), against ~23 µs for #2674's whole prize.
//
// THE MEMO IS ON THE INPUTS, NOT ON THE ANSWER (#3993), and that placement is the whole
// of its soundness. It used to wrap this single-DATE entry point, which the window
// resolver below does not go through — so inside one tick scope, with a
// `poor-sleep-override:` dismissal landing mid-scope, the reminder rebuild (single-date,
// memoized) and the catch-up sheet (windowed, unmemoized) answered the SAME day two
// different ways. #2724's bound had quietly become a split. Memoizing the profile's
// date-independent SOURCES instead puts every consumer in a tick on one snapshot,
// whichever entry point it came through, which is what "bounded to one profile's tick"
// was always claiming.
//
// The writers, enumerated, which is what actually decides it (lib/tick-cache.ts):
//   • IN SCOPE, the one upcoming_dismissals writer the tick reaches is `runPreventive`'s
//     episode-end sweep (`clearPreventiveDismissal`), and it can only delete
//     `<kind>:<ruleKey>` preventive keys with `dismissed_at` set — provably disjoint from
//     `poor-sleep-override:<date>`, the ONE suppression key this resolver consults. No
//     tick path writes situations, cycle rows, sleep samples or the weather cache after
//     `syncIntegrations`, which runs before the scope's first read (the same claim the
//     other tickCached gathers rest on).
//   • CROSS-PROCESS, the web surfaces move this key in BOTH directions while a scope
//     sits open across an awaited dispatch, and the two directions are not equally
//     harmless. A DISMISS mid-scope leaves the memo saying "not overridden", so a
//     situational dose stays due for the rest of that tick — the conservative way. The
//     UN-DISMISS is the one to state plainly: `poor-sleep-override:` is a labelled,
//     RESTORABLE row with a one-tap Restore on Upcoming, and a restore landing mid-scope
//     leaves the memo answering "still overridden", so the item stays NOT DUE for the
//     rest of that profile's tick. That is #2674's own sentence — a snapshot "reads as
//     still silenced, and that is a safety direction" — bounded here to one profile's
//     tick rather than refused, because the prize is ~5 ms rather than ~23 µs and the
//     window is one tick of a context the user has just been editing by hand.
//
// SAME SHAPE AS THE OTHER TICK MEMOS, NOT THE SAME BUS. The staleness window is the
// medication-family gather's (one profile's tick, closed by the scope), but this is the
// FIRST tick-memoized gather that reads `upcoming_dismissals` at all — the bus #2674
// fenced off — so it is a first of its kind rather than one more of a kind.
//
// WHAT IS AND IS NOT SNAPSHOTTED. `getActiveSituations` is read inside here, so the
// DECLARED set is snapshotted with everything else. The dueness seam survives that only
// because `getEffectiveActiveSituations` unions a FRESH `getActiveSituations` read with
// this resolver's memoized DERIVED names — so a situation toggled mid-tick still lands,
// and the memo's blast radius is the derived half alone.
//
// THE DATE IS NOT A MEMO KEY ANY MORE, it is an evaluation parameter. Every day's answer
// is computed from the one snapshot, so two days cannot be served each other's answer by
// a key that forgot to project one of them — the failure `tickCached` warns about is now
// unreachable here rather than guarded against.
//
// This memoizes the SOURCES, not `getFindingSuppressions` itself: the bus read stays
// unmemoized for everyone else (#2674 stands; lib/__db_tests__/tick-suppression-
// freshness.test.ts pins it). The scope boundary, the profile key, the per-day
// independence, the agreement of the two entry points, and the fact that no consumer
// mutates the snapshot are pinned by lib/__db_tests__/tick-derived-situations-memo.test.ts.
// The profile-scoped inputs every derived verdict reads that do NOT depend on which day
// is being asked about. Each is one read whose pure rule then slices per day: the
// declared set and its change log, the suppression bus, the nightly sleep series, the
// cycle relevance bit and the period log, plus the profile's real today as the #2613
// horizon.
interface DerivedSources {
  horizon: string;
  declared: string[];
  events: SituationEvent[];
  suppressions: ReturnType<typeof getFindingSuppressions>;
  sleepOn: (wakeDay: string) => SleepSignal | null;
  cycleRelevant: boolean;
  periods: ReturnType<typeof listCyclePeriods>;
}

const derivedSources = tickCached(
  "derived-situations.sources",
  (profileId: number) => `${profileId}`,
  (profileId: number): DerivedSources => {
    const cycleRelevant = getNavRelevance(profileId).cycle;
    return {
      horizon: today(profileId),
      declared: getActiveSituations(profileId),
      events: getSituationEvents(profileId),
      suppressions: getFindingSuppressions(profileId),
      sleepOn: sleepSignalResolver(profileId),
      cycleRelevant,
      periods: cycleRelevant ? listCyclePeriods(profileId) : [],
    };
  }
);

// The weather half is the one input that depends on the WINDOW rather than only on the
// profile, so it is memoized per declared span. Nothing the tick runs writes the weather
// cache, the symptom log or the keyed-item set after `syncIntegrations`, so two spans in
// one tick cannot disagree about a day they share.
const derivedWeatherOn = tickCached(
  "derived-situations.weather",
  (profileId: number, from: string, to: string) => `${profileId}:${from}:${to}`,
  weatherSituationsResolver
);

// Every derived situation for the profile on `date` — the single-DATE entry point, which
// is this file's window resolver over a one-day window. One implementation, so the two
// cannot drift.
export function resolveDerivedSituations(
  profileId: number,
  date: string
): DerivedSituations {
  return derivedSituationsResolver(profileId, date, date)(date);
}

// EVERY INPUT ABOVE IS READ ONCE, NOT ONCE PER DAY — which is what lets the whole app
// share one dated answer instead of splitting into dated and undated halves (#3993).
//
// The split this replaces was never about what the surfaces MEAN. It was a measured
// cost: the per-date resolver re-read the sleep series, the cycle log, the weather cache
// and the suppression bus for every day a window walked, so dating a 56-day adherence
// pattern cost 56 gathers. Only THREE of those reads even depend on the day (the nights
// before it, the periods covering it, the weather through it) and none of them is a
// per-day query — each is one profile-scoped read the pure rule then slices. Gathering
// once and slicing per day makes a window cost what a single day costs, and the seam
// stops paying for itself.
//
// SAME ANSWER, DAY FOR DAY, as `resolveDerivedSituations` — which is not a claim about
// two implementations agreeing, because there is only one: the single-date entry point
// above is this resolver over a one-day window. Each day is evaluated AS OF ITSELF (the
// nights up to it, the period log's view of it, the weather slice ending on it), so a
// window's answer for a day and a single-day call about it cannot diverge.
//
// The window is a COST HINT, not a contract. A date outside [from, to] is still answered
// correctly — the weather half reads its own slice for it — so a caller that mis-declares
// its window pays more, never lies.
//
// SNAPSHOT LIFETIME IS THE RESOLVER: a
// caller that wants a fresh read builds a fresh resolver. The inputs are gathered LAZILY
// on the first date asked about, so a caller that builds one and never uses it — the
// common case on a profile with nothing keyed to a derived context — pays nothing.
export function derivedSituationsResolver(
  profileId: number,
  from: string,
  to: string
): (date: string) => DerivedSituations {
  interface Inputs extends DerivedSources {
    weatherOn: ReturnType<typeof weatherSituationsResolver>;
  }
  let inputs: Inputs | null = null;
  const load = (): Inputs => {
    if (inputs) return inputs;
    const gathered: Inputs = {
      ...derivedSources(profileId),
      weatherOn: derivedWeatherOn(profileId, from, to),
    };
    inputs = gathered;
    return gathered;
  };

  return (date) => {
    const i = load();
    // A day that has not happened leaves no record to read (#2613: unknowable, not
    // merely uncertain). periodOnDate refuses its own future and no night ends on one,
    // but the weather cache reaches a week AHEAD — so with `date` free, all three need
    // the refusal.
    if (date > i.horizon)
      return {
        poorSleep: { on: false, basis: null },
        period: null,
        weather: [],
        derivedNames: new Set(),
      };
    // The DECLARED set as it stood on `date` (#654/#3973), so the fallback each verdict
    // below carries is dated with the rest — a chip toggled this morning must not report
    // a rough night for last Tuesday. On today it is the current set exactly.
    const active = situationsActiveOn(date, i.declared, i.events);

    // ---- Poor sleep (#1292) ----
    // Missing data ⇒ no sleep signal ⇒ measured never fires ⇒ OFF unless declared (the
    // conservative missing-data-OFF posture). The measured half is the night ENDING
    // `date` against the baseline of the nights before it — the same threshold function
    // the coaching engine calls, so the two can never disagree about what a rough night
    // is. The override is a date-scoped suppression row on the shared bus, so the key
    // for THIS day is the one consulted and a neighbouring day's override never reaches
    // it.
    const poorSleep = roughNightVerdict({
      sleep: i.sleepOn(date),
      thresholds: DEFAULT_COACHING_THRESHOLDS,
      declared: declared(active, BUILTIN_POOR_SLEEP_SITUATION),
      overridden: i.suppressions.has(poorSleepOverrideKey(date)),
    });

    // ---- Period (#1298) ----
    // Gated on the SAME cycle relevance bit the nav uses (#1042): a profile that doesn't
    // track cycles never sees the built-in Period situation. Derived = `date` covered by
    // a logged period (factual, non-predictive — periodOnDate, which takes the subject
    // day and the horizon separately); declared is the fallback.
    const period: PeriodVerdict | null = i.cycleRelevant
      ? periodVerdict({
          coversDate: periodOnDate(i.periods, date, i.horizon) != null,
          declared: declared(active, BUILTIN_PERIOD_SITUATION),
        })
      : null;

    // ---- Weather (#1726) ----
    // Gated on weather relevance (a home location plus either a weather-keyed item or a
    // symptom these situations explain), then decided purely by the cached daily series
    // ending on `date` — never on the forecast tail, so a situation cannot activate on
    // weather that has not happened. Already dated: this is the source the #1360
    // window-source rule names as fully reconstructable. No data ⇒ no situation.
    const weather = i.weatherOn(date).active;

    // Only the names turned on by DERIVATION (not already declared) need adding — a
    // declared toggle is already in getActiveSituations.
    const derivedNames = new Set<string>();
    if (poorSleep.on && poorSleep.basis === "measured")
      derivedNames.add(BUILTIN_POOR_SLEEP_SITUATION);
    if (period?.on && period.basis === "logged")
      derivedNames.add(BUILTIN_PERIOD_SITUATION);
    for (const w of weather) derivedNames.add(w.name);

    return { poorSleep, period, weather, derivedNames };
  };
}

// The number of active situational items keyed to `situation` (name-keyed, #560) that
// can actually GO DUE — the count the state line acknowledges. When the derived
// context is on, these are exactly the items isDueOn's situational branch surfaces.
//
// `may` items are excluded because they have no dueness at all (#1505): saying "1 item
// active" about something that was never going to come due would be acknowledging
// nothing. They remain reachable through the offer surfaces.
function keyedItemCount(
  supps: readonly {
    active?: number | boolean;
    obligation?: IntakeObligation;
    condition?: string;
    situation?: string | null;
  }[],
  situation: string
): number {
  return supps.filter(
    (s) =>
      (s.active ?? true) &&
      s.obligation !== "may" &&
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
  // One acknowledgment per ACTIVE weather situation with keyed items (#1726), in the
  // stable predicate order. Empty on a quiet day, for a non-weather-relevant profile, or
  // when nothing is keyed to the situation that holds — the same "nothing to
  // acknowledge" rule the other two follow.
  weather: string[];
}

// The visible state lines for the derived contexts — the ONE computation the Supplements
// bar, the #1221 check-in Context disclosure, and the morning digest all format over, so
// a Telegram-first user sees the same acknowledgment as the page (#662/#221). Basis-aware
// via the pure formatters; null where the context is off or has no keyed items to surface.
// CHEAP EARLY-OUT: a profile with NO situational item keyed to Poor sleep / Period / a
// weather situation has nothing to surface, so we skip the sleep/cycle/suppression/
// weather reads entirely — the common case, keeping the dashboard render this feeds free
// of derived-context I/O.
//
// `temperatureUnit` is the LOGIN's display preference (units belong to the login, not
// the profile), passed in by the caller that has one; it only affects how a heatwave /
// cold-snap figure READS, never whether the situation holds. Defaults to canonical °C
// for the profile-only callers (the notify tick has no login context).
export function getDerivedSituationLines(
  profileId: number,
  date: string,
  temperatureUnit: TemperatureUnit = "C"
): DerivedSituationLines {
  const supps = getIntakeItems(profileId);
  const poorSleepItems = keyedItemCount(supps, BUILTIN_POOR_SLEEP_SITUATION);
  const periodItems = keyedItemCount(supps, BUILTIN_PERIOD_SITUATION);
  const anyWeatherKeyed = WEATHER_SITUATIONS.some(
    (name) => keyedItemCount(supps, name) > 0
  );
  if (poorSleepItems === 0 && periodItems === 0 && !anyWeatherKeyed) {
    return {
      poorSleep: null,
      period: null,
      poorSleepOverridable: false,
      weather: [],
    };
  }
  const d = resolveDerivedSituations(profileId, date);
  const weather: string[] = [];
  for (const state of d.weather) {
    const line = weatherSituationStateLine({
      state,
      figure: weatherSituationFigure(state, temperatureUnit),
      itemCount: keyedItemCount(supps, state.name),
    });
    if (line) weather.push(line);
  }
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
    weather,
  };
}

// The active-situation NAME set ON `date`, widened by the derived context that held that
// day — the ONE set every dueness surface consumes so a Poor sleep / Period / weather
// situational item goes due exactly while its context holds. Replaces
// `new Set(getActiveSituations(profileId))` at the dueness-surfacing call sites.
//
// BOTH HALVES ARE DATED, which is what lets a past-day caller stop branching (#3993):
// the declared half through #654's change log, the derived half from each source's own
// record. A surface asking about a closed day gets one answer about that day rather than
// a dated half beside a now half, and today's answer is unchanged either way.
//
// ONE QUESTION, ONE ANSWER, ON EVERY SURFACE. "Was this dose owed on that day" is asked
// by the surfaces a person acts on (the reminder rebuild, the catch-up sheet, the
// medications and supplements rows) and by the surfaces that summarise those days back
// to them (the adherence strips, the weekly recap, the demotion evidence, the morning
// digest's "0/1 taken", the adherence pattern findings). They all read this seam, so
// they cannot disagree. Handing the summaries a DECLARED-ONLY resolver instead is what
// let a catch-up sheet offer a dose the strip beside it scored `na` and then discard the
// log when it was taken, and what let the digest push "0/1 taken" for a paused day no
// surface would ever have offered.
//
// A SUMMARY IS AN ACT-ON SURFACE. That is the rule the split got wrong: the morning
// digest states a miss to the person in a push, and the demotion suggestion puts an
// Accept button under its evidence. Neither is a passive read-out, and neither may be
// answered from a different day's facts than the row the person is looking at.
//
// THE DECLARED-ONLY RECONSTRUCTION IS GONE, not moved. `situationsActiveOn` is still the
// pure rule that dates the declared half — the symptom-episode spans and the pooled
// situation-impact windows read it directly, because membership really is their question
// — but nothing in the app now asks for dueness from declarations alone.
//
// THE UNION IS ALSO WHAT BOUNDS THE #2724 MEMO. The declared half is re-read on every
// call, and only the DERIVED half comes out of the tick-scoped snapshot — so a situation
// toggled by hand mid-tick reaches this seam immediately, and the memo can only ever hold
// the derived names stale. The returned Set is the caller's own, so a caller mutating it
// cannot reach the snapshot behind `derivedNames`.
//
// ONE IMPLEMENTATION: this is the window resolver over a one-day window, built fresh per
// call, which is what keeps the declared half fresh per call for the tick.
export function getEffectiveActiveSituations(
  profileId: number,
  date: string
): Set<string> {
  return effectiveSituationResolver(profileId, { from: date, to: date })(date);
}

// The same set for a WINDOW of days, off ONE gather (#3993).
//
// IT MEMOIZES PER DATE, and that is not an optimization — it is the difference between
// this being shippable and not. `intakeAdherenceStrip` asks its resolver once per ITEM
// per DAY, so a 20-item page over a 14-day window asks 280 times.
//
// AND IT GATHERS ONCE PER WINDOW, which is what removed the cost that used to justify
// leaving the summary surfaces undated. `window` names the span the caller is about to
// score, so the derived inputs are read once for the span rather than once per day —
// see `derivedSituationsResolver`. It is a COST HINT, not a contract: a date outside the
// span is answered correctly, just less cheaply.
//
// The snapshot lifetime is the RESOLVER: each call site builds one for the window it is
// about to score, so a caller that wants a fresh read builds a fresh resolver. That is
// the one behavioural difference from asking `getEffectiveActiveSituations` per day,
// which builds a fresh one-day resolver every time — the single-day entry point keeps
// that freshness, and this one keeps a window's days consistent with each other. It is a
// property of holding a resolver, not of any memo: it holds identically outside a tick
// scope, which is exactly what distinguishes it from the #2724 split above.
export function effectiveSituationResolver(
  profileId: number,
  window: { from: string; to: string }
): (date: string) => Set<string> {
  const byDate = new Map<string, Set<string>>();
  let declaredNow: string[] | null = null;
  let events: SituationEvent[] | null = null;
  let derivedOn: ((date: string) => DerivedSituations) | null = null;
  return (date) => {
    let set = byDate.get(date);
    if (set) return set;
    declaredNow ??= getActiveSituations(profileId);
    events ??= getSituationEvents(profileId);
    derivedOn ??= derivedSituationsResolver(profileId, window.from, window.to);
    set = situationsActiveOn(date, declaredNow, events);
    for (const name of derivedOn(date).derivedNames) set.add(name);
    byDate.set(date, set);
    return set;
  };
}
