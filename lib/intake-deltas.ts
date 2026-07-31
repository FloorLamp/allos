// Delta-based intake reporting for the digests (issue #1505 part 3). Pure and
// client-safe — no DB, no network.
//
// "9/13 supplements taken" is a number without news in it: it says nothing about
// WHICH obligations changed state, and it reads the same on the day a five-year
// magnesium habit collapses as on an ordinary Tuesday. This module answers the
// question a digest is actually for — what CHANGED — over exactly the pushed tier
// (high/mandatory supplements + all medications; precisely what `isPushedIntake`
// leaves in a push after #1505 part 1):
//
//   NOTABLY MISSED — a consistent taken-streak that has just broken, reported with
//                    the length of the miss run ("magnesium (3 days)").
//   RESUMED        — taken again after a miss run long enough to have been a lapse.
//
// ONE computation, formatted by every digest channel (#221): the Telegram morning
// digest, the weekly recap (Telegram + the dashboard recap widget), and the
// household card all render `classifyIntakeDeltas` through `intakeDeltaLine`. No
// channel computes its own variant, and no channel invents news — a quiet window
// produces no deltas, `intakeDeltaLine` returns null, and the line is omitted.
//
// The raw adherence fraction is NOT removed; it stays as secondary detail. Adherence
// answers "what did I do" (and still counts low-priority supplements — #221 at the
// definition layer); this answers "what changed among the things that push me".

import type { AdherenceDot } from "./supplement-adherence";

// ---- Window + thresholds --------------------------------------------------
//
// Deliberately NESTED inside the demotion detector's window
// (DEMOTION_WINDOW_DAYS = 30, lib/supplement-demotion.ts): a broken streak is
// today's news, a month of near-total non-adherence is a priority question. Keeping
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
}

// One item's slice: its identity plus the ITEM-LEVEL adherence strip (oldest-first)
// from `supplementAdherenceStrip` — the same per-day aggregation the Supplements
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
    };
  }

  // Trailing take: how long was the lapse immediately before it?
  let i = occ.length - 1;
  while (i >= 0 && isTaken(occ[i])) i--;
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

// How many items each half names before it collapses to "+N more" — a digest line
// has to stay a line.
export const INTAKE_DELTA_MAX_NAMED = 3;

function half(label: string, items: readonly IntakeDelta[]): string | null {
  if (items.length === 0) return null;
  const named = items.slice(0, INTAKE_DELTA_MAX_NAMED);
  const parts = named.map(
    (d) => `${d.name} (${d.days} day${d.days === 1 ? "" : "s"})`
  );
  const rest = items.length - named.length;
  if (rest > 0) parts.push(`+${rest} more`);
  return `${label}: ${parts.join(", ")}`;
}

// THE headline every digest channel renders — "Missed: Magnesium (3 days) ·
// Resumed: Vitamin D (2 days)" — or null on a quiet window, which is the signal to
// omit the line entirely. One formatter so Telegram, the weekly recap and the
// household card can't drift into three phrasings of the same fact.
export function intakeDeltaLine(deltas: IntakeDeltas): string | null {
  const parts = [
    half("Missed", deltas.missed),
    half("Resumed", deltas.resumed),
  ].filter((p): p is string => p != null);
  return parts.length ? parts.join(" · ") : null;
}
