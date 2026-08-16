// The fasting lifecycle's PURE layer (issue #2756). No db import, no clock read: every
// function here takes the state it judges, so the write core, the Nutrition surface and
// the notification stand-down (#2757) all render from ONE derivation instead of three
// that claim to agree.
//
// A FAST IS A CLAIM, NOT A SENSOR READING. Nothing in the app infers a fast from the
// food log — `food_log_events` carries a day and a TAP instant, and inferring eating
// times from tap times turns a distribution of eating times into one of tapping times.
// So the core's job is INTERNAL coherence (one active fast, an end after its start, no
// overlapping intervals) enforced with typed refusals. EXTERNAL incoherence — the claim
// versus the food log — is annotated honestly and never adjudicated: see
// `servingsDuringFast`, which counts and says nothing else.
//
// TWO INSTANTS, ONE DAY ATTRIBUTION. A fast spans a profile-local day boundary by
// nature, so the interval is absolute (UTC instants) and the DAY it counts for is
// derived — a completed fast counts for the day it ENDS (#94), which is the copy the
// surfaces state out loud. `fastAttributedDay` is that derivation and it needs the
// profile timezone, which is why it takes one rather than slicing a string.

import { dateStrInTz, parseUtcSql } from "./date";

// One stored fast, as every reader sees it. `ended_at === null` IS the active state —
// there is no status enum, the same open/closed shape `cycles` and `illness_episodes`
// use. Both instants are on the canonical `YYYY-MM-DDTHH:MM:SSZ` convention.
export interface Fast {
  id: number;
  started_at: string;
  ended_at: string | null;
  note: string | null;
}

// ── The plausibility bound (the #921 stale-session shape, never a timeout) ──────────
//
// Past this many hours an ACTIVE fast stops reading as "in progress" and starts reading
// as "you probably forgot to end this". It is a SUGGEST, not an expiry: the app never
// auto-ends a fast, because "I stopped at some point" and "I never actually fasted" are
// different truths and only the user knows which one happened. 36 h is the top of the
// commonly-practised extended-fast range — long enough that a real 24 h fast is never
// nagged, short enough that a forgotten one surfaces the same day.
export const FAST_STALE_HOURS = 36;

// The longest interval the write core will accept at all, backdated or live. A claim
// longer than this is far likelier to be a mis-set date than a real fast, and accepting
// it would put a bar on every duration chart that dwarfs the real ones. 14 days.
export const FAST_MAX_HOURS = 14 * 24;

// How long after an end was WRITTEN its UNDO stays live. An Undo is the inverse of a
// write the user just made — it is not a general reopen, and the distance between those
// two is the whole of "resolving it by recency could resurrect last week's fast".
// Bounding it by AGE is what makes that sentence true of the CODE rather than only of
// the intention: past this window the completed fast is history, and reopening it would
// mint an active fast out of a row the user finished with days ago.
//
// AGE OF THE WRITE, NOT OF THE INSTANT THE END NAMES, and the two are routinely far
// apart because the surface invites a backdated end out loud. The write core reads
// `fasts.end_written_at` for this and never `ended_at`; measuring the wrong one made
// every backdated end's Undo dead on arrival (lib/fast-write.ts).
export const FAST_REOPEN_MAX_MINUTES = 15;

const MS_PER_HOUR = 3_600_000;

// STORED-INSTANT GRANULARITY. The canonical convention (`YYYY-MM-DDTHH:MM:SSZ`) carries
// SECONDS — `utcInstant` truncates the milliseconds away — so an ordering check in
// MILLISECONDS is judging a precision the column will not keep. Two Dates 400 ms apart
// pass an `end > start` test in ms and then serialize to the SAME string, storing a
// zero-length fast that every downstream duration reads as 0.
//
// Every ordering check in the write cores therefore compares what will actually be
// STORED. The rule lives here so the cores cannot each pick their own precision.
export function instantSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Elapsed milliseconds of a fast at `at` (for an active one) or over its full interval. */
export function fastElapsedMs(fast: Fast, at: Date): number | null {
  const start = parseUtcSql(fast.started_at);
  if (!start) return null;
  const end = fast.ended_at ? parseUtcSql(fast.ended_at) : at;
  if (!end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

/** Elapsed hours, unrounded. `null` when either instant is unreadable. */
export function fastElapsedHours(fast: Fast, at: Date): number | null {
  const ms = fastElapsedMs(fast, at);
  return ms === null ? null : ms / MS_PER_HOUR;
}

// "14 h 20 m" — the duration a control's own label carries, so the button always names
// the write it will perform (#221/#1892). Minutes are dropped past 100 h, where they are
// noise; under an hour it reads "45 m" rather than "0 h 45 m".
export function formatFastDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} m`;
  if (h >= 100) return `${h} h`;
  return `${h} h ${m} m`;
}

// The profile-local day a COMPLETED fast counts for: the day it ENDED (#94). Stated in
// the surface copy, because the alternative (the start day) would file a 16:8 window on
// the evening before the morning it actually shaped. An active fast is attributed to no
// day at all — it has not finished, and guessing would file it twice.
export function fastAttributedDay(fast: Fast, tz: string): string | null {
  if (!fast.ended_at) return null;
  const end = parseUtcSql(fast.ended_at);
  return end ? dateStrInTz(tz, end) : null;
}

// ── The control state (the `offerState` STATEFUL_WRITE_TABLES names) ────────────────
//
// ONE derivation of "what does the fasting control offer right now", rendered by the
// Nutrition chip and re-checked by the write core, so a stale page cannot produce a
// write the surface would never have offered. The three states are exhaustive:
//
//   start    — nothing is open. The control starts a fast.
//   active   — a fast is running and still plausible. The control ends it.
//   stale    — a fast has been running past FAST_STALE_HOURS. The control still ends it,
//              and the surface ALSO offers discard, because at this point "end it with a
//              backdated instant" and "this never happened" are both live answers and
//              the app is not entitled to pick.
export type FastControlState =
  | { kind: "start" }
  | { kind: "active"; fast: Fast; elapsedMs: number }
  | { kind: "stale"; fast: Fast; elapsedMs: number };

export function fastControlState(
  active: Fast | null,
  at: Date
): FastControlState {
  if (!active) return { kind: "start" };
  const elapsedMs = fastElapsedMs(active, at) ?? 0;
  return elapsedMs >= FAST_STALE_HOURS * MS_PER_HOUR
    ? { kind: "stale", fast: active, elapsedMs }
    : { kind: "active", fast: active, elapsedMs };
}

/** The label the control renders — it always names the write the tap will perform. */
export function fastControlLabel(state: FastControlState): string {
  if (state.kind === "start") return "Start fast";
  return `End fast · ${formatFastDuration(state.elapsedMs)}`;
}

// ── Interval coherence (what the write core refuses) ────────────────────────────────

// Do two intervals overlap? A fast's end is EXCLUSIVE for this purpose: ending one fast
// and starting the next at the same instant is a legitimate back-to-back pair, not an
// overlap. An open fast (no end) extends to +infinity, which is what makes
// `already-active` and `overlap` the same question asked from two directions.
export function fastsOverlap(
  aStart: number,
  aEnd: number | null,
  bStart: number,
  bEnd: number | null
): boolean {
  const aFinish = aEnd ?? Number.POSITIVE_INFINITY;
  const bFinish = bEnd ?? Number.POSITIVE_INFINITY;
  return aStart < bFinish && bStart < aFinish;
}

// Every existing fast a proposed interval would collide with. The write core runs this
// INSIDE its transaction against freshly-read rows, so backdating can never manufacture
// an overlap — which is the whole reason backdating is allowed at all.
export function overlappingFasts(
  existing: readonly Fast[],
  startMs: number,
  endMs: number | null,
  ignoreId?: number
): Fast[] {
  return existing.filter((f) => {
    if (ignoreId != null && f.id === ignoreId) return false;
    const s = parseUtcSql(f.started_at);
    if (!s) return false;
    const e = f.ended_at ? parseUtcSql(f.ended_at) : null;
    return fastsOverlap(s.getTime(), e ? e.getTime() : null, startMs, endMs);
  });
}

// ── The food-log follow-up offer ────────────────────────────────────────────────────
//
// Does logging a serving attributed to `logDay` prompt "End your fast?" (#2756)?
//
// THE WRITE IS NEVER GATED ON THIS. Dueness gates nudging, never logging — the serving
// always lands and this is resolved afterwards, beside the successful log. Declining
// changes nothing, and the app never auto-ends a fast: the TAP is the write.
//
// NO LIFE-STAGE GATE BELONGS HERE, and that is a decision rather than an omission. The
// only write this offer can reach is `endFast` — the EXEMPT core — so for a profile that
// became restricted mid-fast the toast is the escape hatch, not a leak: it appears only
// when a fast is ALREADY active, and its tap only ever removes fasting state. Gating it
// would withdraw a way out from the exact person the gate exists to protect, which is
// the stranded-row trap lib/fast-write.ts's exemptions were written against. It also
// cannot appear for a restricted profile that has no fast, because there is nothing to
// end.
//
// ONLY A TODAY-ATTRIBUTED LOG PROMPTS. A backdated serving filed against yesterday says
// nothing about whether the fast running right now should end, and prompting on it
// would invite a tap that ends a fast the user never meant to touch. That is the whole
// of the rule, and it is one pure function over (active fast, the log's attributed day,
// today) so the web bar, the quick-entry overlay and a future Telegram rider cannot
// answer it three ways.
export function promptsEndOfFast(
  active: Fast | null,
  logDay: string,
  today: string
): boolean {
  return active !== null && logDay === today;
}

// ── Honest annotation of external incoherence ───────────────────────────────────────
//
// "2 servings logged during" — the quiet line a completed fast carries in history when
// food was logged inside its interval and the prompt was declined (or never answered).
// BOTH FACTS STAND: the fast is the user's claim and the servings are the user's record,
// and the app is not entitled to decide which one is wrong. So this counts and stops.
//
// It is also the OBSERVABLE for #2385's deceptive-success measure — fast durations
// lengthening while food-log density thins is "fasting more" that is really "logging
// less", which harms the data every other feature reads.
export function servingsDuringFast(
  fast: Fast,
  servingInstants: readonly (string | null)[]
): number {
  const start = parseUtcSql(fast.started_at);
  const end = fast.ended_at ? parseUtcSql(fast.ended_at) : null;
  if (!start) return 0;
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Number.POSITIVE_INFINITY;
  let n = 0;
  for (const raw of servingInstants) {
    const d = raw ? parseUtcSql(raw) : null;
    // A serving with no stated eating instant proves nothing about WHEN it was eaten
    // (the day-grained majority of the food log), so it is not counted. Silence here is
    // honest: the annotation claims only what the ledger actually records.
    if (!d) continue;
    const ms = d.getTime();
    if (ms >= startMs && ms < endMs) n += 1;
  }
  return n;
}

/** "2 servings logged during", or null when there is nothing to annotate. */
export function servingsDuringFastNote(count: number): string | null {
  if (count <= 0) return null;
  return `${count} serving${count === 1 ? "" : "s"} logged during`;
}
