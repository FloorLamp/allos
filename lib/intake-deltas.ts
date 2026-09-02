// Delta-based intake reporting for the digests (issue #1505 part 3). Pure and
// client-safe — no DB, no network.
//
// "9/13 supplements taken" is a number without news in it: it says nothing about
// WHICH obligations changed state, and it reads the same on the day a five-year
// magnesium habit collapses as on an ordinary Tuesday. This module answers the
// question a digest is actually for — what CHANGED — over exactly the pushed tier
// (`must`/`should` supplements + all medications; precisely what `isPushedIntake`
// leaves in a push after #1505 part 1):
//
//   NOTABLY MISSED — a consistent taken-streak that has just broken, reported with
//                    the length of the miss run ("magnesium (3 days)").
//   RESUMED        — taken again after a miss run long enough to have been a lapse.
//
// ONE computation, formatted by every digest channel (#221): the Telegram morning
// digest, the weekly recap (Telegram + the dashboard recap atoms), and the
// household card all render `classifyIntakeDeltas` through `intakeDeltaLine`. No
// channel computes its own variant, and no channel invents news — a quiet window
// produces no deltas, `intakeDeltaLine` returns null, and the line is omitted.
//
// The raw adherence fraction is NOT removed; it stays as secondary detail. Adherence
// answers "what did I do" (and still counts `may` supplements — #221 at the
// definition layer); this answers "what changed among the things that push me".

import type { AdherenceDot } from "./intake-adherence";
import { weekdayOfDateStr, WEEKDAYS_LONG } from "./date";
import {
  formatWeekdayDate,
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "./format-date";

// ---- Window + thresholds --------------------------------------------------
//
// Deliberately NESTED inside the demotion detector's window
// (DEMOTION_WINDOW_DAYS = 30, lib/supplement-demotion.ts): a broken streak is
// today's news, a month of near-total non-adherence is an obligation question. Keeping
// this window strictly shorter is what stops the two engines firing off the same
// evidence and saying different things about the same item; the nesting is pinned
// by a unit test.

// How many trailing days the classifier reads. Two weeks: long enough to contain a
// qualifying streak plus the run that broke it, short enough that the "news" is new.
export const INTAKE_DELTA_DAYS = 14;

// A miss only counts as NOTABLE when this many scheduled occurrences immediately
// before it were followed through. Three is the smallest run that reads as a habit
// rather than a coincidence, and it is what keeps a chronically-erratic item out of
// the digest entirely — there is no streak there to break.
export const NOTABLE_MISS_MIN_STREAK = 3;

// A resumption is only news when the lapse it ended was itself a lapse: this many
// consecutive missed occurrences. One missed day followed by a normal day is not a
// comeback, it is a Tuesday.
export const RESUMED_MIN_MISS_RUN = 2;

// ---- Types ----------------------------------------------------------------

export type IntakeDeltaKind = "missed" | "resumed";

export interface IntakeDelta {
  kind: IntakeDeltaKind;
  itemId: number;
  name: string;
  // The run length the copy reports: for "missed", how many scheduled occurrences
  // have now been missed in a row; for "resumed", how long the lapse it ended was.
  days: number;
  // The date of the run's most recent MISSED occurrence (#3033) — for "missed",
  // the latest miss; for "resumed", the last miss of the lapse the take ended.
  // Already on the AdherenceDot the classifier walks; carried so a
  // single-occurrence miss can name its day instead of the ambiguous "for 1 day"
  // (which counts scheduled occurrences, not calendar days — a weekly item's one
  // missed Monday is one occurrence, not one day out of seven).
  date: string;
}

// One item's slice: its identity plus the ITEM-LEVEL adherence strip (oldest-first)
// from `intakeAdherenceStrip` — the same per-day aggregation the Supplements
// page renders, so the digest and the page can never disagree about a given day.
// The caller passes ONLY pushed-tier items (isPushedIntake); this module does not
// re-derive pushability, it reports on whatever tier it is handed.
export interface IntakeDeltaInput {
  itemId: number;
  name: string;
  strip: AdherenceDot[];
}

export interface IntakeDeltas {
  missed: IntakeDelta[];
  resumed: IntakeDelta[];
}

// ---- Classification -------------------------------------------------------

// Only days the item was actually DUE and not deliberately skipped are occurrences —
// "na" and "skipped" (#232) are transparent, the same definition the adherence
// percentage and the demotion detector use. Cadence (#1602) arrives through "na":
// a streak or lapse run therefore counts a weekly med's MONDAYS, so one missed Monday
// breaks a streak of Mondays rather than reading as six consecutive daily misses.
// percentage and the demotion detector use. Collapsing the strip to its occurrences
// first is what makes an every-other-day supplement classify like a daily one: the
// run lengths below count SCHEDULED occurrences, not calendar days.
function occurrencesOf(strip: readonly AdherenceDot[]): AdherenceDot[] {
  return strip.filter((d) => d.state !== "na" && d.state !== "skipped");
}

function isTaken(dot: AdherenceDot): boolean {
  return dot.state === "taken" || dot.state === "partial";
}

// The state change for one item, or null when nothing changed. Reads the TAIL of the
// occurrence sequence: either it ends in a miss run preceded by a taken streak
// (missed), or it ends in a take preceded by a miss run (resumed).
export function classifyIntakeDelta(
  input: IntakeDeltaInput
): IntakeDelta | null {
  const occ = occurrencesOf(input.strip);
  if (occ.length === 0) return null;
  const last = occ[occ.length - 1];

  if (!isTaken(last)) {
    // Trailing miss run, then the streak that preceded it.
    let missRun = 0;
    let i = occ.length - 1;
    while (i >= 0 && !isTaken(occ[i])) {
      missRun++;
      i--;
    }
    let streak = 0;
    while (i >= 0 && isTaken(occ[i])) {
      streak++;
      i--;
    }
    if (streak < NOTABLE_MISS_MIN_STREAK) return null;
    return {
      kind: "missed",
      itemId: input.itemId,
      name: input.name,
      days: missRun,
      // The most recent miss is the sequence's last occurrence.
      date: last.date,
    };
  }

  // Trailing take: how long was the lapse immediately before it?
  let i = occ.length - 1;
  while (i >= 0 && isTaken(occ[i])) i--;
  const lapseEnd = i >= 0 ? occ[i].date : last.date;
  let missRun = 0;
  while (i >= 0 && !isTaken(occ[i])) {
    missRun++;
    i--;
  }
  if (missRun < RESUMED_MIN_MISS_RUN) return null;
  return {
    kind: "resumed",
    itemId: input.itemId,
    name: input.name,
    days: missRun,
    date: lapseEnd,
  };
}

// Every state change across the pushed tier, split by kind and deterministic within
// each (by name, then item id). Both lists empty = a quiet window; the digest then
// says nothing rather than inventing news.
export function classifyIntakeDeltas(
  inputs: readonly IntakeDeltaInput[]
): IntakeDeltas {
  const all = inputs
    .map(classifyIntakeDelta)
    .filter((d): d is IntakeDelta => d != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId);
  return {
    missed: all.filter((d) => d.kind === "missed"),
    resumed: all.filter((d) => d.kind === "resumed"),
  };
}

export function hasIntakeDeltas(deltas: IntakeDeltas): boolean {
  return deltas.missed.length > 0 || deltas.resumed.length > 0;
}

// ---- The one formatter ----------------------------------------------------

// How many items each half names before it AGGREGATES to a count plus the run range
// (#4228 C) — a digest line has to stay a line.
export const INTAKE_DELTA_MAX_NAMED = 3;

// The period a caller is REPORTING ON, when it spans more than a day (#3033).
// The weekly recap passes its own window; the daily digest and the household card
// pass nothing. Resolved inside the formatter — deliberately not a per-caller
// flag, and not a second phrasing: the day is named as a function of the window,
// because in a day-scale report a one-occurrence miss is almost always yesterday
// and a weekday would add nothing, while a week-scale reader has seven candidate
// days and "for 1 day" says nothing about which one.
export interface IntakeDeltaReportWindow {
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
  // Date-format prefs for a date beyond the window; the notification default
  // applies where no per-login prefs exist (the recap's own rule, #1218).
  prefs?: DisplayFormatPrefs;
}

const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

// A run LENGTH as each kind states it. The two kinds read in opposite directions
// (#4228 B): a miss run is still going — "for 3 days" — while a resume's `days` is the
// lapse the take ENDED, and "Resumed: X for 8 days" read as eight days back on it. So
// the resumed half says which way the number points: "after 8 days missed". A lapse
// longer than the report window is then coherent — it began before the window — and
// the classifier's 14-day read needs no explaining. The missed half is untouched, so
// `intakeGapExplainedBy`'s word-for-word agreement (missed-only) still holds.
function runLength(kind: IntakeDeltaKind, days: string): string {
  return kind === "missed" ? `for ${days}` : `after ${days} missed`;
}

// How one delta's RUN reads, without the name in front of it. A SINGLE-occurrence miss
// inside a multi-day report window names its day — a weekday for a date inside the
// window, a "Mon, 4 Aug"-style date beyond it (the delta classifier looks back further
// than a week) — and everything else reports the run length.
function runSuffix(
  d: IntakeDelta,
  window: IntakeDeltaReportWindow | null
): string {
  if (window != null && window.start < window.end && d.days === 1) {
    const day =
      d.date >= window.start && d.date <= window.end
        ? WEEKDAYS_LONG[weekdayOfDateStr(d.date)]
        : formatWeekdayDate(d.date, window.prefs ?? DEFAULT_FORMAT_PREFS);
    return `on ${day}`;
  }
  return runLength(d.kind, dayCount(d.days));
}

function runPhrase(
  d: IntakeDelta,
  window: IntakeDeltaReportWindow | null
): string {
  return `${d.name} ${runSuffix(d, window)}`;
}

// UNIFORM RUNS ARE STATED ONCE (#3487 item 3). "Missed: X for 1 day, Y for 1 day, Z for
// 1 day, +4 more" repeats the only word that is the same on every item and drops the
// names past three — the line spends its width on the duplicate. When every delta in a
// half shares one run phrase, it is hoisted into the label: "Missed for 1 day: X, Y, Z,
// +4 more". Mixed runs keep the per-item form, because there the duration IS per item.
//
// Judged over ALL the items, not the named three: the hoisted phrase describes the "+N
// more" too, so uniformity read off a truncated sample would state a duration for items
// nobody can see and it could be wrong about them.
//
// A SINGLE item is deliberately NOT hoisted. There is nothing repeated to collapse, and
// "Missed: Magnesium for 3 days" is the exact phrasing `intakeGapExplainedBy` re-uses
// word for word when the fraction line absorbs the delta (#1819 item 6) — one item is
// where those two forms have to agree.
//
// PAST THE NAME CAP, THE HALF AGGREGATES (#4228 C). A stack-wide lapse — eleven
// supplements that stopped and restarted together — is ONE event, and "X for 4 days, Y
// for 8 days, Z for 7 days, +8 more" reported it eleven times with alphabetical order
// choosing which three got named. Exactly where the line would have truncated to "+N
// more", it says the count and the run range instead: "Resumed: 11 supplements after
// 4–8 days missed", or the one shared run when the runs are uniform. At or below the
// cap, the per-item form and the #3487 hoist are byte-identical to before.
function half(
  kind: IntakeDeltaKind,
  items: readonly IntakeDelta[],
  window: IntakeDeltaReportWindow | null
): string | null {
  if (items.length === 0) return null;
  const label = kind === "missed" ? "Missed" : "Resumed";
  const suffixes = items.map((d) => runSuffix(d, window));
  const uniform = items.length > 1 && suffixes.every((r) => r === suffixes[0]);
  if (items.length > INTAKE_DELTA_MAX_NAMED) {
    const runs = items.map((d) => d.days);
    const lo = Math.min(...runs);
    const hi = Math.max(...runs);
    const run = uniform
      ? suffixes[0]
      : runLength(kind, lo === hi ? dayCount(lo) : `${lo}–${hi} days`);
    return `${label}: ${items.length} supplements ${run}`;
  }
  const parts = uniform
    ? items.map((d) => d.name)
    : items.map((d) => runPhrase(d, window));
  return `${uniform ? `${label} ${suffixes[0]}` : label}: ${parts.join(", ")}`;
}

// THE headline every digest channel renders — "Missed: Magnesium for 3 days ·
// Resumed: Vitamin D after 2 days missed", or "Missed for 1 day: Glycine, Magnesium,
// Zinc" when every item in a half shares one run (#3487 item 3), or "Missed: 5
// supplements for 2–4 days" past the name cap (#4228 C) — or null on a quiet window,
// which is the signal to omit the line entirely. One formatter so Telegram, the weekly
// recap and the household card can't drift into three phrasings of the same fact.
// `window` is the caller's reporting period (see IntakeDeltaReportWindow): absent for
// the day-scale surfaces, whose copy is unchanged.
export function intakeDeltaLine(
  deltas: IntakeDeltas,
  window: IntakeDeltaReportWindow | null = null
): string | null {
  const parts = [
    half("missed", deltas.missed, window),
    half("resumed", deltas.resumed, window),
  ].filter((p): p is string => p != null);
  return parts.length ? parts.join(" · ") : null;
}

// ---- The MERGE test (#1819 item 6) ----------------------------------------

// "🔁 Missed: Glycine (1 day)" beside "💊 Supplements: 8/9 taken" states one fact
// twice: the 1 missing IS the Glycine. #1505 part 3 made the delta LEAD with the
// fraction as supporting detail, and that stays right whenever the two carry
// different information — but when the delta fully explains the gap, two lines is one
// line's worth of news wearing two bullets.
//
// FULLY EXPLAINS means all of: exactly one item changed state, it changed by going
// MISSED (a resume is a different fact from a gap), and yesterday's gap is exactly
// one dose. Anything else — a skip, several misses, a mixed missed+resumed window —
// diverges, and the caller keeps both lines. Returns the trailing CLAUSE the fraction
// line absorbs ("missed Glycine (1 day)"), phrased from the SAME name/day-run the
// shared delta formatter renders so the merged and unmerged forms agree word for word.
export function intakeGapExplainedBy(
  deltas: IntakeDeltas,
  gap: number
): string | null {
  if (gap !== 1) return null;
  if (deltas.resumed.length > 0) return null;
  if (deltas.missed.length !== 1) return null;
  const d = deltas.missed[0];
  return `missed ${d.name} ${runLength("missed", dayCount(d.days))}`;
}
