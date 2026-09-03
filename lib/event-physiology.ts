// WHAT AN EVENT DID TO THE BODY (issue #4775 §1) — PURE, no DB, no clock.
//
// One computation (#221) behind four surfaces: the activity page's heart-rate block,
// the post-workout finish message, the practice finish message, and the digest's
// overnight line. Before this module the assembly existed exactly once — inline in
// lib/training-activity-detail.ts as `activityWindows → getHrMinutesInRange →
// scopeBucketsToWindows → zoneMinuteTotals` — and no send could reach it. Extracting
// it rather than copying it is the whole point: a second implementation behind a
// "shared" name is worse than the duplication it replaces.
//
// ── The window is the subject, not the activity ──────────────────────────────
//
// Everything here takes an `ActivityWindow` (lib/training-zones), which is what
// `activityWindow` already produces for an activity row AND for a practice row —
// both carry date / start_time / end_time / duration_min. So a sauna, a barbell
// session and a red-light panel are one question asked three times, and nothing in
// this file knows which it is looking at.
//
// ── COVERAGE IS THE HONESTY GATE, AND IT IS NOT OPTIONAL ─────────────────────
//
// The Health Connect pipeline runs 30–61 min behind the wrist
// (docs/internals/integrations-sync.md, #2560/#2341). At the moment a finish tap
// lands, the session's own minutes are usually NOT in yet. A physiology clause
// computed then is not wrong-by-a-little: it is a confident sentence about a flat
// line that is only flat because the data has not arrived, and it looks exactly like
// a real reading. So `covered` is false until the stream's frontier has passed the
// window END, and every formatter over this result is required to stay silent while
// it is. The failure this prevents produces no exception and no empty state — which
// is why the gate is a field on the result rather than a caller's judgement call.
//
// ── Why the numbers are compared to the person, never to a cutoff ────────────
//
// A "usual" here is the same quantity over that profile's own prior events of the
// same kind. There is no published band for "how much a red-light session should
// raise your heart rate", and inventing one would be the clinical-cutoff language
// #4775 and AGENTS.md both forbid. Below `USUAL_MIN_EVENTS` priors there is no usual
// and the fact renders alone.

import {
  scopeBucketsToWindows,
  zoneMinuteTotals,
  type ActivityWindow,
  type HrBucket,
  type ZoneModel,
} from "./training-zones";

// ── Boundaries ───────────────────────────────────────────────────────────────

// The quiet stretch before the start that a pre-window baseline averages over.
// Fifteen minutes is the issue's own figure and it is kept for the ACTIVITY PAGE,
// which shows the fact beside the window it was measured against. It is deliberately
// NOT what the practice message states: measured over the owner's 11 windowed
// red-light sessions, a session logged straight out of bed carries the get-up
// movement spike inside these fifteen minutes, and the comparison then read −1 bpm on
// a session running 24 bpm above resting (#4775 comment 2026-09-02). The send states
// the rise over the day's RESTING HR instead; the pre-window mean stays in the result
// for the page, which has room to say what it is.
export const PRE_WINDOW_MIN = 15;

// How long after the window's end recovery is still looked for. Two hours: past that
// the reading is describing the person's evening rather than the session, and an
// unbounded scan grows with account age. A window whose HR never re-enters the
// resting range inside the bound reports `recoveryMin: null` — "not within two
// hours", never a number pinned at the bound, because a clamped value reads as a
// measurement and is not one.
export const RECOVERY_BOUND_MIN = 120;

// How many of the profile's own prior events a "usual" averages, and the floor below
// which there is no usual at all. Ten is a recent habit rather than a life history;
// three is the smallest number for which "usually" is not a description of one
// occasion. Below the floor the fact renders with no comparison clause.
export const USUAL_RECENT_EVENTS = 10;
export const USUAL_MIN_EVENTS = 3;

// ── The result ───────────────────────────────────────────────────────────────

/** The in-window facts, or null when the stream measured nothing inside the window. */
export interface EventInWindowHr {
  /** Minutes actually MEASURED inside the window — never the window's own length. */
  measuredMin: number;
  meanBpm: number;
  peakBpm: number;
  /** The lowest reading inside the window — the night's floor, on a sleep session. */
  lowBpm: number;
}

export interface EventPhysiology {
  window: ActivityWindow;
  /**
   * The in-window HR buckets, scoped and sorted — the exact array the activity page
   * used to build inline, carried here so the page consumes this result rather than
   * re-deriving it beside it.
   */
  minutes: HrBucket[];
  inWindow: EventInWindowHr | null;
  /** Zone minutes (index 0 = Z1 … 4 = Z5), or null with no zone model / no minutes. */
  zoneMinutes: number[] | null;
  /** Mean over the `PRE_WINDOW_MIN` before the start, when measured. */
  preWindowMeanBpm: number | null;
  /**
   * Minutes from the window's end until bpm first sat back inside the resting range,
   * or null when it did not inside `RECOVERY_BOUND_MIN` — including because the
   * stream stopped (a wear gap), which is indistinguishable from "still elevated" and
   * must not be reported as either.
   */
  recoveryMin: number | null;
  /** Has the stream's frontier passed the window END? Nothing states physiology unless. */
  covered: boolean;
  /** Minutes between the frontier and `now`, or null when the stream has no frontier. */
  frontierAgeMin: number | null;
}

export interface EventPhysiologyInput {
  window: ActivityWindow;
  /**
   * Every HR bucket that could bear on the window, as profile-LOCAL minute stamps —
   * the pre-window band, the window, and the recovery band. Over-supplying is free
   * (the scoping below is exact); under-supplying silently shortens recovery, which
   * is why the gather reads a day either side rather than the window's own day.
   */
  minutes: readonly HrBucket[];
  zoneModel: ZoneModel | null;
  /**
   * The top of the resting range — the profile's resting-HR baseline plus its spread,
   * the SAME quantity `getRestingHrSignal` feeds the `rest-rhr` rule. Null when the
   * profile has no resting-HR history, which makes recovery unanswerable rather than
   * zero.
   */
  restingCeilingBpm: number | null;
  /** The newest HR minute the profile holds, as a local minute stamp, or null. */
  frontier: string | null;
  /** The moment the question is being asked, as a local minute stamp. */
  now: string;
}

// ── Local-minute arithmetic ──────────────────────────────────────────────────
//
// Every stamp in this module is a profile-local "YYYY-MM-DDTHH:MM" — the form
// `getHrMinutesInRange` projects to and `activityWindow` bounds in. Two of them
// therefore compare correctly as strings (fixed width, most-significant first), and
// the only thing that needs real arithmetic is a DIFFERENCE. Doing that by parsing
// into a Date would re-introduce the zone the projection just removed.

function minutesOf(local: string): number {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, h, min) / 60_000);
}

/** Whole minutes from `from` to `to`, negative when `to` is earlier. */
export function localMinutesBetween(from: string, to: string): number {
  return minutesOf(to) - minutesOf(from);
}

/** `local` shifted by whole minutes, rolling the date. */
export function shiftLocalMinutes(local: string, add: number): string {
  const total = minutesOf(local) + add;
  const d = new Date(total * 60_000);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
}

/** The local DAY a stamp falls on — the prefix, since the stamp is already local. */
export function localDayOfStamp(local: string): string {
  return local.slice(0, 10);
}

/**
 * The days a full physiology read must fetch for this window: the pre-window band's
 * day through the recovery band's day, inclusive. Exported so the gather and the
 * tests bound the same span from one rule.
 */
export function physiologyDaySpan(window: ActivityWindow): {
  from: string;
  to: string;
} {
  return {
    from: localDayOfStamp(shiftLocalMinutes(window.start, -PRE_WINDOW_MIN)),
    to: localDayOfStamp(shiftLocalMinutes(window.end, RECOVERY_BOUND_MIN)),
  };
}

// ── The computation ──────────────────────────────────────────────────────────

function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function eventPhysiology(input: EventPhysiologyInput): EventPhysiology {
  const { window, zoneModel, restingCeilingBpm, frontier, now } = input;
  const all = [...input.minutes].sort((a, b) => a.ts.localeCompare(b.ts));

  const minutes = scopeBucketsToWindows(all, [window]);
  const inWindow: EventInWindowHr | null =
    minutes.length > 0
      ? {
          measuredMin: minutes.length,
          meanBpm: meanOf(minutes.map((b) => b.bpm)),
          peakBpm: Math.max(...minutes.map((b) => b.bpm)),
          lowBpm: Math.min(...minutes.map((b) => b.bpm)),
        }
      : null;

  const zoneMinutes =
    zoneModel && minutes.length > 0 ? zoneMinuteTotals(minutes, zoneModel) : null;

  const preStart = shiftLocalMinutes(window.start, -PRE_WINDOW_MIN);
  const pre = all.filter((b) => b.ts >= preStart && b.ts < window.start);
  const preWindowMeanBpm = pre.length > 0 ? meanOf(pre.map((b) => b.bpm)) : null;

  // RECOVERY. The first minute at or after the window's end whose bpm sits back
  // inside the resting range. `>= window.end` and not `>` because the window is
  // half-open — the minute stamped at `end` is the first one AFTER the session, and
  // excluding it would make a one-minute recovery unreportable.
  let recoveryMin: number | null = null;
  if (restingCeilingBpm != null) {
    const bound = shiftLocalMinutes(window.end, RECOVERY_BOUND_MIN);
    for (const b of all) {
      if (b.ts < window.end) continue;
      if (b.ts > bound) break;
      if (b.bpm <= restingCeilingBpm) {
        recoveryMin = localMinutesBetween(window.end, b.ts);
        break;
      }
    }
  }

  return {
    window,
    minutes,
    inWindow,
    zoneMinutes,
    preWindowMeanBpm,
    recoveryMin,
    // THE GATE. A frontier short of the window's end means the tail of this session
    // has not been delivered yet, so every number above is describing a partial
    // window — and a partial window's mean, peak and zone split all read as real.
    covered: frontier != null && frontier >= window.end,
    frontierAgeMin:
      frontier != null ? Math.max(0, localMinutesBetween(frontier, now)) : null,
  };
}

// ── "Usual", the only comparison this app makes ──────────────────────────────

/**
 * The profile's usual value for a quantity, over its own prior events of the same
 * kind — most recent first. Null below `USUAL_MIN_EVENTS`, which is the signal to
 * render the fact with no comparison clause rather than to invent a weaker one.
 */
export function usualValue(priorsNewestFirst: readonly number[]): number | null {
  const recent = priorsNewestFirst.slice(0, USUAL_RECENT_EVENTS);
  if (recent.length < USUAL_MIN_EVENTS) return null;
  return meanOf(recent);
}

// ── The two derived quantities the sends state ───────────────────────────────

/**
 * The practice-effect metric (#4775, comment 2026-09-02): the in-window mean as a
 * SIGNED rise over the day's resting HR. Signed and never scored — a sauna's rise and
 * a meditation's fall are both "what it did", and calling either good or bad would be
 * the verdict this app does not make.
 *
 * Null when the window measured nothing or the day has no resting HR: the send then
 * has no physiology and, by §3's rule, does not go out at all.
 */
export function practiceEffectBpm(
  physiology: EventPhysiology,
  restingHrBpm: number | null
): number | null {
  if (!physiology.inWindow || restingHrBpm == null) return null;
  return physiology.inWindow.meanBpm - restingHrBpm;
}

/** Zone minutes as `Z2 24 min · Z3 11 min`, loudest-zone-first order preserved. */
export function zoneMinutesClause(zoneMinutes: readonly number[]): string | null {
  const parts = zoneMinutes.flatMap((min, i) =>
    min > 0 ? [`Z${i + 1} ${Math.round(min)} min`] : []
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
