// THE PAIRED-OBSERVATIONS REGISTRY (issue #2177) — a declared, argued set of
// factor × outcome pairs, compared deterministically, silent below declared
// datapoint gates. PURE: no DB, no clock, no network.
//
// ── The defect this closes ────────────────────────────────────────────────────
//
// Two streams the user already logs sit on the same days and are never compared.
// Overnight HRV renders as a lone trend line; an evening's drink renders as a
// food-log tally; nothing asks what one looks like conditioned on the other. The
// one place the app ever did ask — the #992 sleep↔mood bridge — solved every hard
// problem (a datapoint gate, a fixed effect floor instead of p-value machinery,
// coaching-tier reach, month-anchored dismissal, co-occurrence-only copy) and then
// hard-coded the answer for exactly one pair.
//
// ── The three words that are the design ───────────────────────────────────────
//
// REGISTRY. The set of pairs is DATA (`PAIRED_OBSERVATIONS`). Each entry names its
// factor source, its outcome stream, its lag, its per-arm datapoint gate, its
// effect floor, and — mandatorily — the ARGUMENT for why this pair is worth a
// person's attention. Adding a pair is adding a row; the gather's two `switch`es
// are exhaustive over the declared source unions, so a new row that names a source
// nobody can read fails `tsc`, and `lib/__tests__/paired-observations.test.ts`
// fails an entry with an empty argument, a non-positive gate, or a duplicate id.
// The same house pattern as METRIC_KNOWLEDGE, SEND_MARKER_REGISTRY,
// DISMISSAL_KEY_REGISTRY and CADENCE_SCOPES: registry is data, enforcement is a
// reflection test.
//
// DETERMINISTIC. `decidePairedObservation` is arithmetic over two series — a mean
// per arm and their difference. No model call, no inference, no p-value, no
// significance theater (the #161 protocol-compare stance, restated: a single
// person's readings are DESCRIPTIVE, and the honest presentation states the shift
// and the counts and lets the reader judge). The same rows produce the same
// sentence forever.
//
// ABOVE DECLARED DATAPOINT GATES. Below its gates a pair produces NOTHING — not a
// hedged finding, not a "not enough data yet" nag. Silence (the absent-pillar rule,
// #489). The gates are PER PAIR because an alcohol↔HRV pair and a training↔sleep
// pair do not need the same n.
//
// ── What the measure is, and what it is not ───────────────────────────────────
//
// For each day in the trailing window the factor is a yes/no fact from the user's
// own log; the outcome is the measured value `lag` days later. Days carrying both
// are PAIRED DAYS; they split into a PRESENT arm and an ABSENT arm, each arm gets
// its mean, and the finding reports both means with both n values.
//
// It is NOT a causal claim and the copy never makes one. "On the 21 nights after an
// evening with a drink logged your overnight HRV averaged 42 ms; after the 9 with
// none logged, 54 ms" is what the arithmetic supports; "your HRV is worse when you
// drink" is not, and no formatter here can produce it (`copyIsObservational` is
// unit-tested against the advice/causation vocabulary).
//
// CONFOUNDING IS ACKNOWLEDGED, NOT SOLVED. These are co-occurrences over a life,
// not experiments: the evenings someone drinks are also the evenings they eat late,
// stay up, or are on holiday. The copy contract is what makes that honest — the
// arms are named by what was LOGGED, and the finding's evidence line says so.
//
// ABSENCE IS ABSENCE OF A LOG. A day with no alcohol row means "none logged", which
// is not the same as none. Every formatter says "logged" out loud rather than
// asserting the user's behaviour, and the spread gate below is what keeps the
// absent arm from silently becoming "the stretch where I stopped logging".
//
// ── Membership boundary (the argued exclusions matter as much) ────────────────
//
// A FACTOR is a daily CHOICE the user made and logged — a lever they can pull
// tonight. An OUTCOME is a MEASURED stream their body produced overnight or the
// next morning. `PAIRED_OBSERVATION_NON_MEMBERS` records what that boundary keeps
// out and why, including the #992 bridge itself — see the declarations below.

import { shiftDateStr } from "./date";
import { formatMinutes } from "./duration";
import { freshnessAgeDays, freshnessState } from "./freshness";
import type { Substance } from "./substance-use";
import type { BodyMetricKind } from "./types/training";

// The dedupeKey namespace for the suppression bus + the RULE_FINDING_PREFIXES and
// DISMISSAL_KEY_REGISTRY registries.
export const PAIRED_OBS_PREFIX = "paired-obs:";

// Episode key: anchored to the month the observation window ENDS in (#436 episode
// anchoring, the shape #992 already uses), so one dismissal silences THIS pair for
// that month and a pattern that genuinely persists can resurface next month rather
// than being silenced forever. Per PAIR, so hiding the alcohol↔HRV note says
// nothing about the training↔sleep one.
export function pairedObservationKey(
  id: PairedObservationId,
  monthAnchor: string
): string {
  return `${PAIRED_OBS_PREFIX}${id}:${monthAnchor}`;
}

// ---- The declared vocabulary ------------------------------------------------

/** Where the day's yes/no FACTOR comes from. Exhaustively switched by the gather. */
export type PairedFactorSource =
  /** A day with any logged consumption of the substance (units/servings > 0). */
  | { kind: "substance"; substance: Substance }
  /** A day with any logged training session. */
  | { kind: "activity" };

/** Where the day's measured OUTCOME comes from. Exhaustively switched by the gather. */
export type PairedOutcomeStream =
  /** A `metric_samples` daily series (the #14 one-source-per-day rollup). */
  | { kind: "metric-sample"; metric: "hrv_ms" }
  /** A `body_metrics` daily series. */
  | { kind: "body-metric"; metric: BodyMetricKind }
  /** MAIN overnight sleep minutes per wake-day (#1118 — naps never folded in). */
  | { kind: "main-sleep" };

/** How a mean renders in the copy. */
export type PairedOutcomeRender = "value-unit" | "duration";

export interface PairedObservationSpec {
  id: PairedObservationId;
  /**
   * WHY THIS PAIR IS WORTH SURFACING — the physiological or behavioural reason a
   * person could act on, in one or two sentences. Mandatory and non-empty: a pair
   * that is merely computable does not belong in the set, and this field is where
   * that judgement is recorded rather than assumed.
   */
  argument: string;
  /** Why THESE gates — the arithmetic behind the per-arm minimum and the floor. */
  gateArgument: string;
  factor: PairedFactorSource;
  /** The finding's heading. Names both series and nothing else — no verb, no verdict. */
  title: string;
  /** How the arms are NAMED in the copy. Always "logged", never a behaviour claim. */
  presentLabel: string;
  absentLabel: string;
  outcome: PairedOutcomeStream;
  outcomeLabel: string;
  outcomeUnit: string;
  outcomeRender: PairedOutcomeRender;
  /** Decimals for the rendered mean (ignored by the duration renderer). */
  outcomeDecimals: number;
  /**
   * Days between the factor day and the outcome day. 1 = "the night after"
   * (overnight HRV, next-morning resting HR, the wake-day a night is filed under).
   */
  lagDays: 1;
  /** Trailing FACTOR days considered. */
  windowDays: number;
  /** Minimum paired days PER ARM. Below it, nothing renders — ever. */
  minPairedDaysPerArm: number;
  /** Minimum |difference of arm means|, in the outcome's OWN units. */
  effectFloor: number;
  /**
   * Adult-only CONTENT (#1174/#1279): the substance pairs name alcohol and nicotine,
   * whose whole surface is adult-gated, so a known minor's profile must never render
   * them. Declared per row rather than pattern-matched on the factor kind, so a future
   * age-neutral substance pair (or an age-gated non-substance one) answers for itself.
   */
  adultOnly: boolean;
  /**
   * The outcome stream must still be live: the newest paired day may be at most
   * this many days old (#2097/#2146's stream-active posture, decided through the
   * shared `freshnessState`). A stream that stopped three weeks ago cannot produce
   * a present-tense observation.
   */
  outcomeCurrentDays: number;
}

export const PAIRED_OBSERVATION_IDS = [
  "alcohol-hrv",
  "alcohol-resting-hr",
  "nicotine-hrv",
  "training-sleep",
] as const;

export type PairedObservationId = (typeof PAIRED_OBSERVATION_IDS)[number];

// The registry. FOUR pairs — deliberately small. The registry is the multiplicity
// control: a fifth pair is one row, and it has to bring its argument with it.
export const PAIRED_OBSERVATIONS: Record<
  PairedObservationId,
  PairedObservationSpec
> = {
  // ── 1. The motivating pair (#2177's fixture) ────────────────────────────────
  "alcohol-hrv": {
    id: "alcohol-hrv",
    argument:
      "Ethanol clearance holds sympathetic tone up for most of the sleep period, " +
      "and overnight HRV is the routinely-measured signal that moves most with it — " +
      "typically the largest single-evening effect anywhere in a wearable's data. " +
      "The lever is a choice made in the evening, and the size of the effect is " +
      "personal enough that only the reader's own two arms can state it.",
    gateArgument:
      "Overnight HRV wobbles ~8-10 ms night to night, so an 8-night arm mean carries " +
      "roughly 3 ms of noise; an 8 ms floor sits clear of that in both arms without " +
      "any inferential machinery. 8 per arm also echoes the #992 bridge's 7-night gate.",
    factor: { kind: "substance", substance: "alcohol" },
    title: "Overnight HRV and evenings with a drink",
    presentLabel: "an evening with a drink logged",
    absentLabel: "an evening with none logged",
    outcome: { kind: "metric-sample", metric: "hrv_ms" },
    outcomeLabel: "overnight HRV",
    outcomeUnit: "ms",
    outcomeRender: "value-unit",
    outcomeDecimals: 0,
    lagDays: 1,
    windowDays: 90,
    minPairedDaysPerArm: 8,
    effectFloor: 8,
    adultOnly: true,
    outcomeCurrentDays: 7,
  },

  // ── 2. The same evening, through the instrument most people actually have ───
  "alcohol-resting-hr": {
    id: "alcohol-resting-hr",
    argument:
      "The same evening's alcohol metabolism raises overnight heart rate, and " +
      "resting HR is reported by essentially every wearable — including the many " +
      "that never expose HRV. This is the pair that reaches a profile whose device " +
      "gives one overnight number, so the fact above is not restricted to the " +
      "minority of devices with a usable HRV stream. A profile carrying both " +
      "streams sees both notes, each with its own arms and its own n: they are two " +
      "different measured quantities, not one fact printed twice.",
    gateArgument:
      "Overnight resting HR is a low-variance measure (nightly SD ~2-3 bpm), so an " +
      "8-night arm mean is steady to well under 1 bpm; 3 bpm is both clear of that " +
      "and about the smallest difference a reader would call a difference.",
    factor: { kind: "substance", substance: "alcohol" },
    title: "Morning resting heart rate and evenings with a drink",
    presentLabel: "an evening with a drink logged",
    absentLabel: "an evening with none logged",
    outcome: { kind: "body-metric", metric: "resting_hr" },
    outcomeLabel: "next-morning resting heart rate",
    outcomeUnit: "bpm",
    outcomeRender: "value-unit",
    outcomeDecimals: 0,
    lagDays: 1,
    windowDays: 90,
    minPairedDaysPerArm: 8,
    effectFloor: 3,
    adultOnly: true,
    outcomeCurrentDays: 7,
  },

  // ── 3. The substance the app already helps people cut ──────────────────────
  "nicotine-hrv": {
    id: "nicotine-hrv",
    argument:
      "Nicotine is a direct sympathomimetic with a half-life long enough to reach " +
      "into the night, and overnight HRV is where that shows up. It earns a row " +
      "beside alcohol rather than being folded into it because it is a different " +
      "substance with a different ledger and a different reader: someone working a " +
      "reduction target already has the app's help counting uses, and this is the " +
      "one place their own body's response to a use-evening is stated back to them. " +
      "Copy obeys the #998 substance-use contract — descriptive, never judgemental, " +
      "no milestones, no advice verb.",
    gateArgument:
      "Same instrument, same noise as the alcohol↔HRV pair, so the same 8-per-arm " +
      "and 8 ms constants: two pairs reading one stream must not disagree about what " +
      "counts as a difference in it.",
    factor: { kind: "substance", substance: "nicotine" },
    title: "Overnight HRV and days with nicotine logged",
    presentLabel: "a day with nicotine logged",
    absentLabel: "a day with none logged",
    outcome: { kind: "metric-sample", metric: "hrv_ms" },
    outcomeLabel: "overnight HRV",
    outcomeUnit: "ms",
    outcomeRender: "value-unit",
    outcomeDecimals: 0,
    lagDays: 1,
    windowDays: 90,
    minPairedDaysPerArm: 8,
    effectFloor: 8,
    adultOnly: true,
    outcomeCurrentDays: 7,
  },

  // ── 4. The self-experiment people actually run ─────────────────────────────
  "training-sleep": {
    id: "training-sleep",
    argument:
      "\"Does training help me sleep?\" is among the most common self-experiments " +
      "people run, and the honest answer is individual: some sleep longer after a " +
      "session, some are wired by one. Both series are already logged at no extra " +
      "cost, and the answer is only worth anything as YOUR number. It is also the " +
      "pair most likely to be silent, which is the point — under the gates there is " +
      "no finding, and a genuine null stays unstated rather than being dressed up.",
    gateArgument:
      "Nightly main-sleep duration has a wide spread (SD ~50-60 min), so the arms " +
      "have to be bigger before a 30-minute difference means anything: 10 per arm is " +
      "about three weeks for a typical training rhythm and costs nothing to wait for. " +
      "Half an hour is the smallest sleep difference that is legible on a clock.",
    factor: { kind: "activity" },
    title: "Sleep after training days and after rest days",
    presentLabel: "a day with a session logged",
    absentLabel: "a day with none logged",
    outcome: { kind: "main-sleep" },
    outcomeLabel: "that night's main sleep",
    outcomeUnit: "",
    outcomeRender: "duration",
    outcomeDecimals: 0,
    lagDays: 1,
    windowDays: 90,
    minPairedDaysPerArm: 10,
    effectFloor: 30,
    adultOnly: false,
    outcomeCurrentDays: 7,
  },
};

export const PAIRED_OBSERVATION_LIST: readonly PairedObservationSpec[] =
  PAIRED_OBSERVATION_IDS.map((id) => PAIRED_OBSERVATIONS[id]);

// ---- The argued NON-members -------------------------------------------------

// Doctrine §1: "the argued exclusions matter as much as the memberships". These are
// decisions, not gaps — a reviewer reading the registry should find the boundary
// written down rather than inferring it from what is absent.
export interface PairedObservationExclusion {
  subject: string;
  reason: string;
}

export const PAIRED_OBSERVATION_NON_MEMBERS: readonly PairedObservationExclusion[] =
  [
    {
      subject: "The #992 sleep↔mood bridge (lib/mood-observation.ts)",
      reason:
        "Not a paired observation, on both axes. Its MEASURE is a within-subject " +
        "WINDOW SHIFT (recent 14/28 days vs the prior 14/28) gated on a second " +
        "window verdict, not a between-arm conditional mean — folding it in would " +
        "REPLACE the computation, not relocate it. And its factor fails the " +
        "membership rule: a two-week fall in sleep regularity is an OUTCOME, not a " +
        "lever anyone can pull tonight, while every registered factor is a choice " +
        "the user made and logged. It also sits under #992's product-decided " +
        "mental-health contract — it speaks only when mood is already low, and never " +
        "volunteers a sleep→mood claim unprompted. It keeps its own module, its own " +
        "prefix and its own copy.",
    },
    {
      subject: "Mood valence as an OUTCOME",
      reason:
        "Outcomes are MEASURED streams. A 1-5 self-rating conditioned on a behaviour " +
        "the same person logged the evening before is exactly where recall and " +
        "attribution bias live, and an arm mean would present that as a measurement. " +
        "Out for v1 by that argument, not by omission.",
    },
    {
      subject: "A supplement or medication as a FACTOR",
      reason:
        "\"Does this thing I take do anything?\" is already ONE question with ONE " +
        "computation: the #161 protocol comparison (lib/protocol-compare.ts), which " +
        "compares a declared intervention window against the equal-length baseline " +
        "before it. A second per-item engine here would be a fork of it (#221).",
    },
    {
      subject: "Caffeine servings as a FACTOR",
      reason:
        "The food log is DAY-grained, so a morning espresso and a 9pm one are the " +
        "same row. The pair that would matter (late caffeine → that night's sleep) " +
        "is not derivable from what is stored, and the day-grained version silently " +
        "answers a different question.",
    },
    {
      subject: "Bedtime as a FACTOR against the same night's duration",
      reason:
        "Near-tautological against a roughly fixed wake time — the arithmetic would " +
        "restate the clock rather than tell anyone anything.",
    },
    {
      subject: "Null results (\"no association\")",
      reason:
        "Out of scope for v1 by the absent-pillar rule (#489): under the gates, or " +
        "under the floor, there is NO finding and no text. Stating a null well is its " +
        "own copy problem and would need its own decision.",
    },
  ];

// ---- The measure ------------------------------------------------------------

/** One day carrying both a factor verdict and the lagged outcome value. */
export interface PairedDay {
  /** The FACTOR day (the outcome was measured `lagDays` later). */
  date: string;
  present: boolean;
  value: number;
}

export interface PairedArm {
  days: number;
  mean: number;
}

export interface PairedComparison {
  id: PairedObservationId;
  present: PairedArm;
  absent: PairedArm;
  /** present.mean − absent.mean, in the outcome's own units. */
  delta: number;
  /** The newest OUTCOME day among the paired days (the freshness anchor). */
  latestOutcomeDay: string;
  /** Total paired days behind both arms. */
  pairedDays: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Build the paired days for one spec: walk every FACTOR day in
 * [`windowStart`, `today`], look `lagDays` forward for a measured outcome, and keep
 * the days that carry both.
 *
 * Iterating FACTOR days (not outcome rows) is what makes the two arms symmetric:
 * every day in the window gets exactly one verdict, so an absent day is a real day
 * the window covered rather than a day nobody looked at.
 */
export function pairedDays(
  spec: PairedObservationSpec,
  factorDays: ReadonlySet<string>,
  outcome: readonly { date: string; value: number }[],
  today: string
): PairedDay[] {
  const byDate = new Map(outcome.map((o) => [o.date, o.value]));
  const out: PairedDay[] = [];
  for (let back = spec.windowDays - 1; back >= 0; back--) {
    const day = shiftDateStr(today, -back);
    const value = byDate.get(shiftDateStr(day, spec.lagDays));
    if (value == null || !Number.isFinite(value)) continue;
    out.push({ date: day, present: factorDays.has(day), value });
  }
  return out;
}

/**
 * THE SPREAD GATE. Both arms must appear in BOTH halves of the paired sequence.
 *
 * Without it the arms can be two PHASES of a life rather than two conditions in
 * one: someone who logged their drinking for three weeks and then stopped has a
 * "present" arm that is really "the weeks I was paying attention" and an "absent"
 * arm that is really "the weeks I was not", and the difference between them is
 * whatever else changed in between. Requiring each arm on both sides of the median
 * paired day is the cheapest deterministic check that the two conditions were
 * genuinely interleaved. Arithmetic, not statistics: it looks at dates, not values.
 */
export function armsAreSpread(days: readonly PairedDay[]): boolean {
  if (days.length < 2) return false;
  const mid = Math.floor(days.length / 2);
  const halves = [days.slice(0, mid), days.slice(mid)];
  return halves.every(
    (half) => half.some((d) => d.present) && half.some((d) => !d.present)
  );
}

/**
 * THE ONE DECISION. Returns the comparison, or null when the pair must stay silent.
 *
 * Gate order is part of the contract: enough data, then genuinely interleaved, then
 * a difference big enough to be worth a sentence, then a stream that is still live.
 * Every "no" is silence — never a hedged finding and never a nag for more data.
 */
export function decidePairedObservation(
  spec: PairedObservationSpec,
  days: readonly PairedDay[],
  today: string
): PairedComparison | null {
  const present = days.filter((d) => d.present);
  const absent = days.filter((d) => !d.present);
  if (
    present.length < spec.minPairedDaysPerArm ||
    absent.length < spec.minPairedDaysPerArm
  )
    return null;
  if (!armsAreSpread(days)) return null;

  const presentMean = mean(present.map((d) => d.value));
  const absentMean = mean(absent.map((d) => d.value));
  const delta = presentMean - absentMean;
  if (Math.abs(delta) < spec.effectFloor) return null;

  // The newest OUTCOME day, one lag forward from the newest paired factor day.
  const latestOutcomeDay = shiftDateStr(
    days[days.length - 1].date,
    spec.lagDays
  );
  // A dead stream cannot produce a present-tense observation (#2097/#2146), decided
  // through the shared freshness vocabulary rather than a local `age > n`.
  if (
    freshnessState(
      freshnessAgeDays(latestOutcomeDay, today),
      spec.outcomeCurrentDays
    ) !== "current"
  )
    return null;

  return {
    id: spec.id,
    present: { days: present.length, mean: presentMean },
    absent: { days: absent.length, mean: absentMean },
    delta,
    latestOutcomeDay,
    pairedDays: days.length,
  };
}

// ---- The copy ---------------------------------------------------------------

function renderMean(spec: PairedObservationSpec, value: number): string {
  if (spec.outcomeRender === "duration") return formatMinutes(value);
  const n = value.toFixed(spec.outcomeDecimals);
  return spec.outcomeUnit ? `${n} ${spec.outcomeUnit}` : n;
}

/**
 * The finding's body. Both arms' n ALWAYS render — an observation that hides its
 * sample size is how trust erodes (#2177 constraint 3) — and the sentence states
 * what was logged and what was measured, in that order, with no verb connecting
 * them causally.
 */
export function pairedObservationDetail(
  spec: PairedObservationSpec,
  cmp: PairedComparison
): string {
  const nights = spec.lagDays === 1 ? "nights" : "days";
  return (
    `Over the last ${Math.round(spec.windowDays / 30)} months, on the ` +
    `${cmp.present.days} ${nights} after ${spec.presentLabel}, ${spec.outcomeLabel} ` +
    `averaged ${renderMean(spec, cmp.present.mean)}. On the ${cmp.absent.days} ` +
    `${nights} after ${spec.absentLabel}, it averaged ` +
    `${renderMean(spec, cmp.absent.mean)}. Both figures are averages of your own ` +
    `readings — the two often move together, which is not the same as one moving ` +
    `the other.`
  );
}

/** The provenance line: where the arms came from, and what "absent" really means. */
export function pairedObservationEvidence(
  spec: PairedObservationSpec,
  cmp: PairedComparison
): string {
  return (
    `${cmp.pairedDays} of the last ${spec.windowDays} days carried both a log entry ` +
    `and a reading. Days with no entry count as "none logged", which is not the same ` +
    `as none — and other things differ between the two groups too.`
  );
}

// The words a co-occurrence note may never contain: an ADVICE verb turns an
// observation into an instruction (and the copy contract has no advice verb — even
// "consider…" is out), while a CAUSAL verb turns arithmetic into a claim the data
// cannot support. "On days after under 6h sleep, your logged mood averaged lower" and
// "your mood is worse when you sleep under 6h" are very different sentences, and only
// the first is what a difference of two means supports.
//
// Matched on WORD BOUNDARIES, never as bare substrings — "try" inside "entry" is not
// an advice verb, and a scanner that thinks so is one that gets deleted the first time
// it fires wrongly.
export const FORBIDDEN_OBSERVATION_WORDS = [
  "because",
  "causes",
  "caused",
  "cause of",
  "you should",
  "consider",
  "try",
  "avoid",
  "cut back",
  "worse when",
  "better when",
  "improves",
  "harms",
] as const;

/** Whether a rendered string honours the copy contract. */
export function copyIsObservational(text: string): boolean {
  const t = text.toLowerCase();
  return !FORBIDDEN_OBSERVATION_WORDS.some((w) =>
    new RegExp(`\\b${w}\\b`).test(t)
  );
}

/** Days between two dates, re-exported shape used by the gather's window math. */
export function pairedWindowStart(
  spec: PairedObservationSpec,
  today: string
): string {
  return shiftDateStr(today, -(spec.windowDays - 1));
}
