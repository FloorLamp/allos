// THE RECAP SCALE AXIS (issue #2178) — "how did the last period go?" asked at three
// lengths by ONE engine, with the length as DATA.
//
// The periodic review used to be a weekly-only feature: one window, one marker, one
// message, and a module named after the seven days it happened to cover. #2166 left
// the monthly/quarterly question open as an explicit product decision, and the owner
// ruled it in as a CADENCE — `weekly | monthly | quarterly`, default weekly — that
// REPLACES the weekly recap rather than stacking beside it.
//
// This module is that axis. Every difference between a weekly, a monthly and a
// quarterly recap is a field on a row below: the period arithmetic, the send marker,
// the narrative kind, the nouns the copy speaks, the gather bound. Nothing branches on
// the scale — `lib/recap.ts` builds the line model from a declared per-line scale set,
// `lib/notifications/recap-data.ts` gathers from the declared window, and the tick
// asks ONE pure planner which scale (if any) speaks today. Adding a fourth length is
// adding a row.
//
// It is deliberately the same shape as `lib/queries/cadence-ledger.ts` over
// `lib/cadence.ts` (one ledger, adapters distinguished by declared options) and
// `lib/nudge-cadence.ts` (one decision, four adapters). A recap at a longer scale is
// not a different feature; it is the same question with a longer window.
//
// ── REPLACE, NEVER STACK ─────────────────────────────────────────────────────────
//
// The behavioural half, and the part a person feels. A profile has ONE recap slot —
// the weekday + time it already consented to (`notify_recap_day` / `notify_recap_hour`,
// off by default). Every scale arrives IN THAT SLOT and nowhere else, so no scale can
// ever add an interruption:
//
//   THE PRECEDENCE RULE. At a recap slot, a scale is APPLICABLE when it is at or above
//   the profile's chosen cadence, its calendar period has closed, and this slot is the
//   FIRST one on or after the day it closed. Exactly one recap is sent: the applicable
//   scale with the LONGEST period. The scales it outranks are marked spent for their
//   own period without sending — their news is inside the one that went out, so they
//   are spent, not queued.
//
// On the first slot on or after Jan 1 / Apr 1 / Jul 1 / Oct 1, a weekly profile has a
// week, a month AND a quarter closed at once. That is the quarter-end Sunday, and it
// sends ONE quarterly recap — not three messages, not three cards. The weekly and
// monthly recaps for those same days are not lost; they are contained in the one that
// speaks at the longest scale.
//
// ── WHY THIS NEEDS NO NEW CONSENT ────────────────────────────────────────────────
//
// The attention doctrine (`docs/internals/findings.md`) lets the system reduce contact
// unilaterally and never increase it. Because a larger scale can only ever REPLACE the
// send that was already going to happen in a slot the user configured, the monthly and
// quarterly recap reach every profile with the recap enabled without asking for
// anything new: the send count is unchanged for a weekly profile (one per slot) and
// strictly lower for a monthly or quarterly one. Choosing a longer cadence is a
// contact REDUCTION, which is a user's to make freely. The system never moves the
// setting itself.
//
// The annual retrospective (#2179) is deliberately NOT a fourth row here: a profile
// whose only review arrives every twelve months has no review, and a year does not fit
// in a message. It is a rendered surface with a pointer send, and because it would
// STACK beside the chosen cadence it needs its own toggle. This registry owns the
// review; it does not own the retrospective.

import { shiftDateStr, weekdayOfDateStr, isoDate } from "./date";
import type { WeekMode, WeekStart } from "./settings";

/** The three lengths the periodic review speaks at. Ordered shortest → longest. */
export type RecapScale = "week" | "month" | "quarter";

/**
 * A completed (or in-progress) period and the immediately prior same-shaped period —
 * the ONE comparison model #2166 asked for, now typed and carrying its own scale.
 *
 * MONTHS AND QUARTERS ARE ALWAYS CALENDAR. `week_mode` defines only WEEKS (the pure
 * week-window module says so in its own header); there is no rolling-month convention
 * in this app and this change does not invent one.
 */
export interface PeriodComparison {
  scale: RecapScale;
  /** The subject period. */
  start: string;
  end: string;
  /** The immediately preceding same-shaped period. */
  prevStart: string;
  prevEnd: string;
  /**
   * True when `end` is today and the period has NOT closed yet — the dashboard card's
   * window. The send always narrates a CLOSED period (#1021's semantics, generalized).
   */
  inProgress: boolean;
}

export interface RecapScaleEntry {
  scale: RecapScale;
  /** Precedence: the LONGEST applicable period wins the slot. Strictly increasing. */
  rank: number;
  /** The period noun the copy speaks ("last week" / "last month"). */
  noun: string;
  /** The adjective form, for prose and narrative headings. */
  adjective: string;
  /** The card heading and the notification title. */
  label: string;
  /** The stored `notify_recap_scale` value AND the `narratives.kind` value. */
  value: RecapScale;
  /** Roughly how many days the period spans — a GATHER BOUND, never period math. */
  approxDays: number;
  /** What this scale is for, in one sentence. Read by the settings copy and the docs. */
  blurb: string;
}

/**
 * THE registry. One row per scale; `rank` is the precedence order and the ONLY thing
 * that decides a collision.
 */
export const RECAP_SCALES: readonly RecapScaleEntry[] = [
  {
    scale: "week",
    rank: 1,
    noun: "week",
    adjective: "weekly",
    label: "Weekly recap",
    value: "week",
    approxDays: 7,
    blurb:
      "Seven days: what you did, what you took, and where your weight sat — the facts a single day cannot show.",
  },
  {
    scale: "month",
    rank: 2,
    noun: "month",
    adjective: "monthly",
    label: "Monthly recap",
    value: "month",
    approxDays: 31,
    blurb:
      "A calendar month: the SHAPE of the month — training composition, the weekday/weekend adherence pattern, and where body weight is heading.",
  },
  {
    scale: "quarter",
    rank: 3,
    noun: "quarter",
    adjective: "quarterly",
    label: "Quarterly recap",
    value: "quarter",
    approxDays: 92,
    blurb:
      "A calendar quarter: the horizon goals and training blocks actually live on, where three months of drift becomes a direction.",
  },
];

const BY_SCALE = new Map(RECAP_SCALES.map((e) => [e.scale, e]));

/** The registry row for a scale. Total over the union, so it never returns null. */
export function recapScaleEntry(scale: RecapScale): RecapScaleEntry {
  return BY_SCALE.get(scale) ?? RECAP_SCALES[0];
}

/** Precedence rank; larger = longer period = wins a collision. */
export function recapScaleRank(scale: RecapScale): number {
  return recapScaleEntry(scale).rank;
}

/**
 * Parse a stored/submitted cadence. Anything unrecognised — absent, empty, a value from
 * a build that offered a different set — reads as `week`, the default and the shortest:
 * an unreadable setting must never SILENCE a review the user turned on.
 */
export function parseRecapScale(raw: string | null | undefined): RecapScale {
  return RECAP_SCALES.some((e) => e.value === raw)
    ? (raw as RecapScale)
    : "week";
}

/** The scales at or above `floor` — the ones a profile on that cadence may hear from. */
export function recapScalesAtOrAbove(floor: RecapScale): RecapScale[] {
  const min = recapScaleRank(floor);
  return RECAP_SCALES.filter((e) => e.rank >= min).map((e) => e.scale);
}

// ── Calendar arithmetic ──────────────────────────────────────────────────────────
// All of it on YYYY-MM-DD strings, so it is timezone-free by construction: the caller
// has already resolved the profile's local day.

function partsOf(dateStr: string): { y: number; m: number; d: number } {
  return {
    y: Number(dateStr.slice(0, 4)),
    m: Number(dateStr.slice(5, 7)),
    d: Number(dateStr.slice(8, 10)),
  };
}

// `isoDate` takes a ZERO-based month; every `m` in this module is the 1-based digit
// pair out of the date string, so each call converts explicitly at the boundary.

/** The first day of the calendar month containing `dateStr`. */
export function monthStartOf(dateStr: string): string {
  const { y, m } = partsOf(dateStr);
  return isoDate(y, m - 1, 1);
}

/** The first day of the calendar quarter (Jan/Apr/Jul/Oct) containing `dateStr`. */
export function quarterStartOf(dateStr: string): string {
  const { y, m } = partsOf(dateStr);
  return isoDate(y, m - 1 - ((m - 1) % 3), 1);
}

/** Shift a MONTH START by `n` months. Leap years and month lengths are irrelevant to
 *  a first-of-month, which is why every window below is anchored on one. */
function shiftMonthStart(monthStart: string, n: number): string {
  const { y, m } = partsOf(monthStart);
  const total = y * 12 + (m - 1) + n;
  return isoDate(Math.floor(total / 12), total % 12, 1);
}

/** The last day of the month/quarter that STARTS on `start` and spans `months`. */
function periodEndFrom(start: string, months: number): string {
  return shiftDateStr(shiftMonthStart(start, months), -1);
}

/** How many months one period of this scale spans; null for the week scale. */
function monthSpan(scale: RecapScale): number | null {
  return scale === "month" ? 1 : scale === "quarter" ? 3 : null;
}

/** The calendar-period start containing `dateStr`, for a month/quarter scale. */
function calendarStartOf(scale: RecapScale, dateStr: string): string {
  return scale === "quarter" ? quarterStartOf(dateStr) : monthStartOf(dateStr);
}

/**
 * The first date on or after `from` whose weekday is `weekday` (0 = Sunday). The
 * arrival rule's whole arithmetic: a period closes on a calendar boundary, and its
 * recap arrives at the next occurrence of the slot the user configured.
 */
export function firstWeekdayOnOrAfter(from: string, weekday: number): string {
  const delta = (weekday - weekdayOfDateStr(from) + 7) % 7;
  return delta === 0 ? from : shiftDateStr(from, delta);
}

/**
 * The calendar month/quarter period as of `today`.
 *
 * `completed` (the SEND) is the last period that has fully closed; otherwise (the
 * dashboard CARD) it is the in-progress period through today. Either way `prev*` is
 * the immediately preceding whole period, so a comparison is always like-for-like.
 */
function calendarPeriod(
  scale: RecapScale,
  today: string,
  completed: boolean
): PeriodComparison {
  const months = monthSpan(scale) ?? 1;
  const current = calendarStartOf(scale, today);
  const start = completed ? shiftMonthStart(current, -months) : current;
  const prevStart = shiftMonthStart(start, -months);
  return {
    scale,
    start,
    end: completed ? periodEndFrom(start, months) : today,
    prevStart,
    prevEnd: periodEndFrom(prevStart, months),
    inProgress: !completed,
  };
}

/**
 * The week period, delegating to the profile's ONE definition of "this week"
 * (`lib/week-window.ts`, honoring `week_mode`) so the weekly recap keeps matching the
 * routine counters and the journal (#223), and the notification keeps summarizing the
 * last COMPLETED calendar week (#1021). Byte-for-byte the pre-#2178 behaviour.
 */
function weekPeriod(
  today: string,
  completed: boolean,
  weekMode: WeekMode,
  weekStart: WeekStart,
  resolve: WeekWindowResolver
): PeriodComparison {
  const win = resolve(today, weekMode, weekStart, completed);
  return {
    scale: "week",
    ...win,
    // Rolling mode's window always ends on `today` — a trailing seven days is a full
    // week whichever day you ask on, which is why #1021 left it untouched. Calendar
    // mode's completed window genuinely ends in the past.
    inProgress: win.end >= today && !completed,
  };
}

/** The week-window computation, injected so this module stays free of lib/recap.ts. */
export type WeekWindowResolver = (
  today: string,
  weekMode: WeekMode,
  weekStart: WeekStart,
  completed: boolean
) => { start: string; end: string; prevStart: string; prevEnd: string };

export interface RecapPeriodOptions {
  weekMode?: WeekMode;
  weekStart?: WeekStart;
  /** True for the SEND (a closed period); false/omitted for the dashboard CARD. */
  completed?: boolean;
  /** The week-window resolver — `resolveRecapWindow` in every real caller. */
  resolveWeek: WeekWindowResolver;
}

/** The period a recap at `scale` covers as of `today`. */
export function recapPeriod(
  scale: RecapScale,
  today: string,
  opts: RecapPeriodOptions
): PeriodComparison {
  const completed = opts.completed ?? false;
  if (scale === "week")
    return weekPeriod(
      today,
      completed,
      opts.weekMode ?? "rolling",
      opts.weekStart ?? 0,
      opts.resolveWeek
    );
  return calendarPeriod(scale, today, completed);
}

// ── The send plan: applicability, precedence, spend ──────────────────────────────

export interface RecapSlotContext {
  /** The profile's chosen cadence — the SHORTEST scale it may hear from. */
  floor: RecapScale;
  /** The profile-local date of the slot being evaluated. */
  today: string;
  /** The configured recap weekday (0 = Sunday) — the one slot every scale arrives in. */
  weekday: number;
  weekMode?: WeekMode;
  weekStart?: WeekStart;
  /**
   * Each scale's marker: the END DATE of the period it last spoke for, or null/absent
   * when it never has. Equality with the candidate period's end means "already spent".
   */
  sentPeriodEnd: Partial<Record<RecapScale, string | null>>;
  resolveWeek: WeekWindowResolver;
}

export interface RecapCandidate {
  scale: RecapScale;
  period: PeriodComparison;
}

export interface RecapSendPlan {
  /** The one recap to send — the longest applicable period — or null. */
  send: RecapCandidate | null;
  /**
   * Every applicable scale's period, INCLUDING the one being sent. All of them are
   * marked spent: a superseded scale's news is inside the message that went out, so
   * leaving it armed would deliver it again at the next slot.
   */
  spend: readonly RecapCandidate[];
  /** The applicable scales the winner outranked, longest first. Reported, not sent. */
  superseded: readonly RecapScale[];
}

/**
 * Is this scale's period closed AND is this slot the first arrival opportunity since
 * it closed? For the week scale the answer is yes at every slot by construction (a week
 * closes every week), which is exactly the pre-#2178 behaviour. For month and quarter
 * the period closes on a calendar boundary, so its recap arrives at the first
 * configured weekday on or after that boundary — never on a boundary day the profile
 * did not ask to be interrupted on, and never as a second message.
 *
 * The "first arrival" clause is also what stops a deploy or a re-enable delivering
 * stale news: on the tenth Sunday after a month closed, that month's arrival day is
 * long past and nothing fires.
 */
function arrivesToday(
  candidate: PeriodComparison,
  today: string,
  weekday: number
): boolean {
  if (candidate.scale === "week") return true;
  return (
    firstWeekdayOnOrAfter(shiftDateStr(candidate.end, 1), weekday) === today
  );
}

/**
 * THE precedence decision. Pure — no DB, no clock, no I/O; every input is an argument,
 * including the date and the markers.
 */
export function planRecapSend(ctx: RecapSlotContext): RecapSendPlan {
  const applicable: RecapCandidate[] = [];
  for (const scale of recapScalesAtOrAbove(ctx.floor)) {
    const period = recapPeriod(scale, ctx.today, {
      weekMode: ctx.weekMode,
      weekStart: ctx.weekStart,
      completed: true,
      resolveWeek: ctx.resolveWeek,
    });
    if (!arrivesToday(period, ctx.today, ctx.weekday)) continue;
    // Already spent for THIS period: a retry within the slot, or a second tick in the
    // same attempt band, must not send twice.
    if ((ctx.sentPeriodEnd[scale] ?? null) === period.end) continue;
    applicable.push({ scale, period });
  }
  if (applicable.length === 0) return { send: null, spend: [], superseded: [] };
  // The longest period wins. Ranks are strictly increasing, so this is total.
  const send = applicable.reduce((best, c) =>
    recapScaleRank(c.scale) > recapScaleRank(best.scale) ? c : best
  );
  return {
    send,
    spend: applicable,
    superseded: applicable
      .filter((c) => c.scale !== send.scale)
      .sort((a, b) => recapScaleRank(b.scale) - recapScaleRank(a.scale))
      .map((c) => c.scale),
  };
}
