// PAIRED OBSERVATIONS (issue #2177) — a declared registry of factor × outcome pairs,
// and the one pure engine that decides whether a pair has anything honest to say.
//
// ── What this generalizes ────────────────────────────────────────────────────
// The sleep↔mood bridge (#992, lib/mood-observation.ts) shipped the shape: two things
// the user already logs, compared over a gated minimum of datapoints, rendered calmly
// with co-occurrence phrasing and dismissible on a month-anchored episode key. It
// solved every hard problem — a min-datapoint gate, FIXED effect floors instead of
// p-value machinery, coaching-tier reach, "the two often move together, never causal,
// never clinical" copy. What it could not do is say anything about a THIRD stream, so
// a ~22% overnight-HRV gap between drink evenings and dry evenings was invisible in an
// app that holds both logs.
//
// This module is that shape with the pair DECLARED instead of hard-coded. It is
// deliberately NOT a generalization of #992's own bridge; see "Why #992 is not an
// entry here" below.
//
// ── The registry IS the multiplicity control ─────────────────────────────────
// There is no miner here and there must never be one. Comparing every logged factor
// against every measured stream over a life's worth of days produces a statement for
// any question you care to ask, which is how a health app starts producing plausible
// nonsense at scale. So: PAIRED_OBSERVATIONS below is a FIXED, SHORT, HUMAN-REVIEWABLE
// list. Every entry writes down, in prose, why this particular comparison is worth one
// of the registry's slots — and an entry costs a paragraph of argument plus a reader in
// lib/queries/paired-observations.ts, on purpose. If adding the fiftieth pair ever feels
// cheap, the design has drifted and the drift is the bug.
//
// The factor always comes from the user's OWN LOGS — a row they wrote — never inferred
// behaviour. "You seem to have been sedentary" is not a factor; "you logged a drink" is.
//
// ── Gates are legible constants, never statistics ────────────────────────────
// Two numbers per pair, both in units a reader can check: nights PER ARM
// (PAIRED_MIN_NIGHTS_PER_ARM) and a fixed effect floor in the OUTCOME'S OWN UNIT
// (entry.outcome.floor). No p-values, no confidence intervals, no significance
// language — #992's stance, reaffirmed by #2177. Wrong-by-a-little beats
// unexplainable, and a floor is auditable in code review by anyone.
//
// ── Silence is the answer below the floor (v1) ───────────────────────────────
// #2177 constraint 4: a pair whose arms differ by less than its floor renders NOTHING.
// This is the absent-pillar rule, and it is a real cost — "we compared trained and rest
// nights over 44 and 9 nights and they were the same" is genuinely useful, and saying
// nothing is indistinguishable from never having looked. It is deferred rather than
// denied: a no-association surface has its own copy problem (a null stated calmly is
// still a claim, and it is the claim most easily over-read as "nothing you do matters")
// and #2177 rules it its own issue. The training→sleep entry below is declared anyway,
// precisely so the null case is exercised end to end.
//
// ── Confounding is acknowledged, not solved ──────────────────────────────────
// These are co-occurrences over a life, not experiments. Drink evenings are also later
// evenings, social evenings, weekend evenings. Nothing here adjusts for anything, and
// no arrangement of this data could establish a cause. The copy contract is the whole
// of the honesty: both arms' n is always visible, the words state that two things
// showed up together, and no sentence tells the user what to do about it.
//
// A second, quieter confound the control arm DOES address: absence of a log is not
// absence of the thing. A day with no drink logged may be a day with no drink or a day
// with no logging, and treating the second as the first silently loads the control arm
// with the user's untracked evenings. So each entry DECLARES its control rule — either
// the day must carry independent evidence that the factor's log surface was in use
// (`logging-evidence`, the food-regularity discipline: a day with no food log is
// evidence about logging, not about eating), or absence genuinely is a state the app
// already treats as such (`absence-is-a-state`: a day with no activity is a rest day
// everywhere else in Allos).
//
// ── Reach: coaching tier, and nothing more ───────────────────────────────────
// PAIRED_OBS_PREFIX is registered `coaching` in RULE_FINDING_REGISTRY. These findings
// join collectCoachingFindings and render on the calm, hideable dashboard rollup. They
// never reach Upcoming, never notify, never occupy the non-hideable hero, and never
// become an obligation. Dismissal is month-anchored (#436) so a dismissal silences the
// pair for the month and a pattern that genuinely persists can resurface; the stem is
// declared as `episodeFamily` (#2543) so repeat declines are read as an answer (#2386)
// by the same machinery that reads every other coaching topic's.
//
// ── Adult-only content ───────────────────────────────────────────────────────
// An alcohol-conditioned factor is substance-use subject matter, which is adult-only by
// product ruling (#1174/#1279). An entry declares `adultOnly` and
// pairedObservationsFor() drops it for a known minor — the same positive-match-only
// policy as everywhere else (unknown age passes, #494), and the same read-side shape
// buildSubstanceUseFindings already uses. The gate lives HERE, in the pure entry
// selection both the builder and its tests call, rather than at the surface, because a
// gate a second caller can walk past is theatre (#2107). No write core is added by this
// change, so ADULT_ONLY_WRITE_CORES is untouched.
//
// ── Why #992 is not an entry here ────────────────────────────────────────────
// The sleep↔mood bridge is the ancestor of this module, not a member of it. Its arms
// are TWO TIME WINDOWS of one stream (recent 14 nights vs the 14 before, and an SRI
// anchored 28 days apart), gated on a separately-detected low-mood window; a registry
// entry's arms are TWO SETS OF DAYS inside ONE window, split by a factor the user
// logged on each day. Expressing the bridge as an entry would mean calling "the date is
// recent" a factor, which is exactly the thing this registry forbids — a factor is a
// row the user wrote, and the calendar is not a log. It would also have to model the
// bridge's low-mood precondition, its two alternative outcomes with different floors,
// and its either-or phrasing, none of which any other pair wants. What the two DO share
// is the vocabulary — fixed floors, per-arm minimums, month-anchored keys, coaching
// tier, co-occurrence copy — and that is the part this module generalizes. #992 keeps
// its own module and its own two constants; nothing about it changed here.
//
// ── #2385: how this feature would learn it should stop ───────────────────────
// It claims to change what a user believes about their own data, so it declares:
//
//   • WHAT WOULD SHOW IT WORKING. A firing pair is followed by the user opening the
//     outcome's own surface (the finding's actionHref) — they went and looked at the
//     series — and the pair is not dismissed on its next monthly raising. Both are
//     local reads over rows the instance already holds.
//   • WHAT WOULD SHOW IT WRONG. The same pair fires, is dismissed, and fires again the
//     next month with arm means that moved by less than the floor: the app is
//     re-raising a fact the user has already answered, dressed as news. Also wrong: a
//     pair that fires for most profiles that have both streams — a "pattern" everyone
//     has is a property of the streams, not of the person, and belongs in a body of
//     knowledge rather than an observation about them.
//   • DECEPTIVE SUCCESS. **Observations surfaced per profile.** It is the obvious
//     measure and it improves exactly as the feature does harm: every pair added, every
//     floor lowered, every arm minimum relaxed raises it, while each one makes the
//     average statement flimsier and the set as a whole less trustworthy. A registry
//     that grew from three pairs to thirty would look like a triumph by that number and
//     would have destroyed the thing the feature is for. The count is a cost, not a
//     score — which is why the argued registry, not a tuning knob, is the design.
//
// Pure: no DB, no clock, no I/O. The gathering half is lib/queries/paired-observations.ts
// and the finding half is buildPairedObservationFindings (lib/rule-findings.ts).

import { daysBetweenDateStr } from "./date";
import { formatMinutes } from "./duration";
import { metricDetailHref, type AppRoute } from "./hrefs";

// dedupeKey namespace for the suppression bus + the RULE_FINDING_REGISTRY entry.
export const PAIRED_OBS_PREFIX = "paired-obs:";

// ── The gates every pair shares ──────────────────────────────────────────────

// Trailing window both arms are drawn from. A quarter: long enough for a weekly
// habit to put ~12 days in the smaller arm, short enough that the statement is about
// how the person lives now rather than how they lived last winter.
export const PAIRED_WINDOW_DAYS = 90;

// Minimum nights in EACH arm. #2177 suggests ≥8, in the spirit of #992's 7 — one arm
// of 3 nights is an anecdote whatever the gap between the means, and the smaller arm
// is the one that decides that.
export const PAIRED_MIN_NIGHTS_PER_ARM = 8;

// The outcome series must still be alive: its newest in-window reading is no older
// than this. #2177 constraint 6 — a stream that stopped two months ago must not keep
// producing a fresh-sounding observation from stale nights. (The #2097/#2146 quiet-
// stream vocabulary answers a narrower question — a CONTINUOUS stream on a declared
// source's connection — and none of these daily outcome series is one of those, so the
// gate is stated here in the terms this module can actually check: recency of the data
// the observation is computed from.)
export const PAIRED_OUTCOME_RECENCY_DAYS = 14;

// ── The declared axes ────────────────────────────────────────────────────────

// Which of the user's own logs the factor predicate reads. A closed union, because the
// reader binding lives in lib/queries/paired-observations.ts and the compiler should
// name that file when a member is added — the registry never assembles SQL.
export type PairedFactorSource = "alcohol-servings" | "logged-activity";

// Which measured series the outcome is read from. Same closed-union discipline.
export type PairedOutcomeStream =
  | "overnight-hrv"
  | "next-morning-resting-hr"
  | "main-sleep-minutes";

// How the CONTROL arm is populated — the "absence of a log" question above.
//   • logging-evidence  — a day joins the without-arm only when it carries independent
//                         evidence the factor's log surface was in use that day.
//   • absence-is-a-state — absence is itself the state, as the rest of the app already
//                         treats it.
export type PairedControlRule = "logging-evidence" | "absence-is-a-state";

// How the arm means are rendered: a plain number with a unit, or a duration.
export type PairedValueFormat = "number" | "duration";

export interface PairedObservationEntry {
  // Identity within the namespace: dedupeKey is `paired-obs:<key>:<YYYY-MM>`.
  key: string;
  factor: {
    source: PairedFactorSource;
    control: PairedControlRule;
    // Substance-use subject matter → withheld from a known minor (#1174/#1279).
    adultOnly: boolean;
    // Copy: "On <withPhrase> (21 nights), …; <withoutPhrase> (9 nights), …".
    withPhrase: string;
    withoutPhrase: string;
  };
  outcome: {
    stream: PairedOutcomeStream;
    // Copy: "… overnight HRV averaged 42 ms".
    label: string;
    unit: string;
    format: PairedValueFormat;
    decimals: number;
    // Days AFTER the factor day the outcome is dated on. Allos anchors a night on its
    // WAKE day (mainSleepNights, and Oura's own `day` for a long sleep), so an evening
    // factor on day D pairs with the outcome dated D+1.
    offsetDays: number;
    // The fixed effect floor, in `unit`. Below it: silence.
    floor: number;
  };
  title: string;
  // Where the reader goes to see the outcome series for themselves. Never advice.
  actionHref: AppRoute;
  actionLabel: string;
  // WHY this pair earns a slot. Reviewed by a human; the point of the registry.
  rationale: string;
}

export const PAIRED_OBSERVATIONS: readonly PairedObservationEntry[] = [
  {
    // Slot argued: this is the pair #2177 was opened for. Both streams are already in
    // the app and neither can see the other — HRV renders as a lone trend line, alcohol
    // as a food-log tally — so a gap of this size is invisible to a user who is looking
    // at both surfaces. Overnight HRV is also the outcome with the best-known evening-
    // alcohol association in the general literature, which matters here only as a
    // reason to spend a slot LOOKING, never as something the copy may assert.
    key: "alcohol-hrv",
    factor: {
      source: "alcohol-servings",
      control: "logging-evidence",
      adultOnly: true,
      withPhrase: "evenings with a drink logged",
      withoutPhrase: "on evenings without",
    },
    outcome: {
      stream: "overnight-hrv",
      label: "overnight HRV",
      unit: "ms",
      format: "number",
      decimals: 0,
      offsetDays: 1,
      // 8 ms. Night-to-night HRV is genuinely noisy (an individual's own SD is commonly
      // 5–10 ms), so a smaller mean gap over eight nights an arm is not something a
      // reader could confirm on the chart they are being pointed at.
      floor: 8,
    },
    title: "Drink evenings and overnight HRV",
    actionHref: metricDetailHref("hrv"),
    actionLabel: "View HRV",
    rationale:
      "The motivating pair (#2177): both logs exist, neither surface can see the other, " +
      "and the gap in the issue's own profile was ~12 ms — far above any floor a reader " +
      "would call noise.",
  },
  {
    // Slot argued: resting HR is the outcome MOST profiles actually have. HRV needs a
    // wearable that reports RMSSD; a morning resting HR arrives from nearly every
    // source and from manual entry, so this is the entry that makes the alcohol factor
    // legible to someone with no HRV stream at all. It is a near neighbour of the pair
    // above and will sometimes fire beside it — two lines about one night is a real
    // cost, accepted because the two arms are stated separately and each states its own
    // numbers. It is also the pair most likely to stay silent: the issue's own fixture
    // shows a 1.2 bpm gap, well under this floor, which is the correct outcome.
    key: "alcohol-resting-hr",
    factor: {
      source: "alcohol-servings",
      control: "logging-evidence",
      adultOnly: true,
      withPhrase: "evenings with a drink logged",
      withoutPhrase: "on evenings without",
    },
    outcome: {
      stream: "next-morning-resting-hr",
      label: "next-morning resting heart rate",
      unit: "bpm",
      format: "number",
      decimals: 0,
      offsetDays: 1,
      // 3 bpm. Resting HR drifts a couple of beats with fitness, illness and the device
      // itself; three is where a mean difference stops being inside that drift.
      floor: 3,
    },
    title: "Drink evenings and next-morning resting heart rate",
    actionHref: metricDetailHref("resting-hr"),
    actionLabel: "View resting HR",
    rationale:
      "The same factor against the outcome nearly every profile has, so the observation " +
      "is not restricted to HRV-capable wearables. Expected to be silent more often than " +
      "not — the floor is above the gap the issue's fixture shows.",
  },
  {
    // Slot argued: the counterweight. Training is the factor users most expect to see a
    // sleep effect from, and in the issue's own data there ISN'T one (427 vs 433 minutes
    // over 44 and 9 nights). Declaring the pair means the app has looked and stays quiet
    // rather than never having looked — and it keeps a pair in the registry whose
    // expected behaviour on real data is silence, which is the case the gate matrix must
    // keep passing. Absence of an activity row is a rest day everywhere else in Allos,
    // so this one takes `absence-is-a-state`.
    key: "training-sleep",
    factor: {
      source: "logged-activity",
      control: "absence-is-a-state",
      adultOnly: false,
      withPhrase: "nights after a logged workout",
      withoutPhrase: "after rest days",
    },
    outcome: {
      stream: "main-sleep-minutes",
      label: "main sleep",
      unit: "min",
      format: "duration",
      decimals: 0,
      offsetDays: 1,
      // 30 minutes. Half an hour of mean nightly sleep is a difference a person would
      // recognise; anything smaller is inside the noise of when they happened to go to
      // bed.
      floor: 30,
    },
    title: "Workout days and that night's sleep",
    actionHref: "/sleep" as AppRoute,
    actionLabel: "View sleep",
    rationale:
      "The pair users assume exists. Declared so the app can be quiet about it on " +
      "evidence rather than by omission, and so the registry keeps a member whose honest " +
      "answer on realistic data is 'nothing above the floor'.",
  },
];

// The entries in play for a profile. The ONE selection both the builder and the tests
// use, so the adult gate cannot be true of the surface and false of a second caller
// (#2107). Positive-match-only: an UNKNOWN age keeps everything (#494's policy for
// content framing), the same answer buildSubstanceUseFindings gives.
export function pairedObservationsFor(opts: {
  isKnownMinor: boolean;
}): readonly PairedObservationEntry[] {
  return opts.isKnownMinor
    ? PAIRED_OBSERVATIONS.filter((e) => !e.factor.adultOnly)
    : PAIRED_OBSERVATIONS;
}

export function pairedObservationEntry(
  key: string
): PairedObservationEntry | null {
  return PAIRED_OBSERVATIONS.find((e) => e.key === key) ?? null;
}

// The topic stem (#2543) and the month-anchored episode key (#436). A dismissal
// silences THIS pair for THIS month; a pattern that persists resurfaces next month, and
// the repeated declines are what dismissal fatigue reads.
export function pairedObservationFamily(key: string): string {
  return `${PAIRED_OBS_PREFIX}${key}`;
}

export function pairedObservationSignalKey(
  key: string,
  monthAnchor: string
): string {
  return `${pairedObservationFamily(key)}:${monthAnchor}`;
}

// ── The engine ───────────────────────────────────────────────────────────────

// One paired night: the day the outcome is dated on, which arm it belongs to, and the
// outcome's value. The gather layer has already applied the offset and the control
// rule, so a day that qualifies for neither arm never appears here.
export interface PairedNight {
  date: string; // YYYY-MM-DD, the OUTCOME's day
  factor: boolean; // true → the with-arm
  value: number; // in the outcome's unit
}

export interface PairedArm {
  nights: number;
  mean: number;
}

export interface PairedObservationVerdict {
  key: string;
  dedupeKey: string;
  episodeFamily: string;
  title: string;
  detail: string;
  withArm: PairedArm;
  withoutArm: PairedArm;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function formatValue(value: number, entry: PairedObservationEntry): string {
  return entry.outcome.format === "duration"
    ? formatMinutes(value)
    : `${round(value, entry.outcome.decimals)} ${entry.outcome.unit}`;
}

function nightsWord(n: number): string {
  return n === 1 ? "1 night" : `${n} nights`;
}

// Collapse to ONE value per date before anything is counted. The gather layer reads
// day-grained series, but a date reaching this twice (two sources, a nap folded in by a
// future reader) must contribute ONE night to ONE arm — an arm count is a count of
// nights, and a double-counted night inflates exactly the number the copy asks the
// reader to judge it by. First occurrence wins; the series are ordered oldest→newest.
function oneNightPerDate(nights: readonly PairedNight[]): PairedNight[] {
  const byDate = new Map<string, PairedNight>();
  for (const n of nights) if (!byDate.has(n.date)) byDate.set(n.date, n);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The pair's verdict, or null — and null is by far the common answer. Gates, in order:
//   1. the outcome series is still alive (newest paired night within the recency gate);
//   2. BOTH arms hold at least PAIRED_MIN_NIGHTS_PER_ARM distinct nights;
//   3. the arm means differ by at least the pair's declared floor.
// Below any of them: nothing renders (v1's silence rule, #2177 constraint 4).
export function decidePairedObservation(
  entry: PairedObservationEntry,
  nights: readonly PairedNight[],
  today: string,
  monthAnchor: string
): PairedObservationVerdict | null {
  const paired = oneNightPerDate(nights);
  if (paired.length === 0) return null;

  const newest = paired[paired.length - 1].date;
  const age = daysBetweenDateStr(newest, today);
  if (age == null || age > PAIRED_OUTCOME_RECENCY_DAYS) return null;

  const withValues = paired.filter((n) => n.factor).map((n) => n.value);
  const withoutValues = paired.filter((n) => !n.factor).map((n) => n.value);
  if (
    withValues.length < PAIRED_MIN_NIGHTS_PER_ARM ||
    withoutValues.length < PAIRED_MIN_NIGHTS_PER_ARM
  )
    return null;

  const withMean = mean(withValues);
  const withoutMean = mean(withoutValues);
  if (Math.abs(withMean - withoutMean) < entry.outcome.floor) return null;

  // Both arms' n is in the sentence, always (#2177 constraint 3): a reader who cannot
  // see the arm sizes cannot judge the claim. No direction word, no advice verb, no
  // causal or clinical language — the two numbers ARE the direction.
  const detail =
    `On ${entry.factor.withPhrase} (${nightsWord(withValues.length)}), ` +
    `${entry.outcome.label} averaged ${formatValue(withMean, entry)}; ` +
    `${entry.factor.withoutPhrase} (${nightsWord(withoutValues.length)}), ` +
    `${formatValue(withoutMean, entry)}. Two things from your own log over the last ` +
    `${PAIRED_WINDOW_DAYS} days that showed up together — not a cause, and not a diagnosis.`;

  return {
    key: entry.key,
    dedupeKey: pairedObservationSignalKey(entry.key, monthAnchor),
    episodeFamily: pairedObservationFamily(entry.key),
    title: entry.title,
    detail,
    withArm: { nights: withValues.length, mean: withMean },
    withoutArm: { nights: withoutValues.length, mean: withoutMean },
  };
}
