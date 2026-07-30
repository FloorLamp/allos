// The Timeline day view's intraday panel — PURE model (issue #1068).
//
// The panel is the timeline day ROTATED 90°: the same events the day's feed lists,
// projected onto a 00:00–24:00 clock axis. One gather, two formatters (this model
// feeds the SVG above and the feed lists below) — the #221 "one question, one
// computation" shape: `getIntradayDay` (lib/queries/intraday.ts) gathers, this
// module decides, `components/IntradayPanel.tsx` only draws.
//
// No DB, no network, no timezone math: every input is already expressed in
// PROFILE-LOCAL terms (hr_minutes.ts is a profile-local 'YYYY-MM-DDTHH:MM' by
// design — #94; the gather converts the two absolute-instant inputs, sleep session
// windows and "now", into local minutes before calling in). So the axis is a plain
// wall-clock axis and there is nothing to convert at render time.
//
// DST (documented, not engineered): the axis is always the wall clock 00:00→24:00.
// On a spring-forward day the skipped hour simply has no stored minutes, so the HR
// line breaks over it like any other wear gap; on a fall-back day the repeated wall
// hour was already merged into one `hr_minutes` row at ingest (the ts IS the local
// minute string, and the ingest upsert count-weights a collision), so it reads as
// one hour. Neither case needs special handling here.

import { shiftDateStr } from "./date";
import { activityWindow } from "./training-zones";
import {
  timelineEntryAnchorId,
  type TimelineCategory,
  type TimelineEvent,
} from "./timeline-format";

// The wall-clock span of the axis. See the DST note above — this is deliberately a
// constant, not a per-day computed length.
export const MINUTES_IN_DAY = 1440;

// Downsample width. 1440 per-minute buckets over a 24 h day is far more than an
// ~700 px-wide SVG can resolve and bloats the RSC payload, so the MODEL (never the
// formatter) collapses them to 5-minute points: at most 1440 / 5 = 288.
export const INTRADAY_BUCKET_MINUTES = 5;
export const INTRADAY_MAX_POINTS = MINUTES_IN_DAY / INTRADAY_BUCKET_MINUTES;

// A wear gap wider than this breaks the HR line into a new segment instead of
// drawing a straight interpolation across hours of missing data (which would read
// as a measured flat HR). Also what makes a DST spring-forward hour a visible gap.
export const INTRADAY_GAP_MINUTES = 15;

export type SleepStage = "deep" | "rem" | "light" | "awake";

// ── Inputs (all profile-local) ───────────────────────────────────────────────

// One stored per-minute HR bucket. `ts` is the profile-local 'YYYY-MM-DDTHH:MM';
// `n` is the sample count behind the bucket's count-weighted average (used to
// weight the 5-minute merge, so a 1-sample minute can't outvote a 30-sample one).
export interface IntradayHrBucket {
  ts: string;
  bpm: number;
  bpm_min?: number | null;
  bpm_max?: number | null;
  n?: number | null;
}

// A sleep session (or stage) window as MINUTES relative to the rendered day's local
// midnight. Values outside [0, 1440] are legal and expected — a session entering
// from before midnight is negative, one running past midnight exceeds 1440 — and
// get CLIPPED here (never re-attributed to another day: the #94 day bucketing for
// aggregates is untouched).
export interface IntradaySpanInput {
  key: string;
  startMinute: number;
  endMinute: number;
  stages?: { stage: SleepStage; startMinute: number; endMinute: number }[];
}

export interface IntradayInput {
  date: string;
  // The feed's OWN event set for this day — already filtered by the feed's
  // visibility rules (age restriction, category filter). Passing the resolved list
  // rather than re-querying is what makes the panel's "one visibility predicate"
  // true BY CONSTRUCTION: a hidden feed event can't reach this function at all.
  events: TimelineEvent[];
  hr: IntradayHrBucket[];
  sleep: IntradaySpanInput[];
  // The profile's Zone 2 bpm band, from the SAME zone model the Trends zone
  // section and the weekly recap read (getProfileZoneModel) — never a second
  // formula. Null when no max HR can be resolved.
  zone2: { low: number; high: number } | null;
  // Wall-clock minute of "now", set ONLY when the rendered day is the profile's
  // today. Null on every other day (no now-marker).
  nowMinute: number | null;
}

// ── Model (what the SVG draws) ───────────────────────────────────────────────

export interface IntradayHrPoint {
  minute: number;
  bpm: number;
  lo: number;
  hi: number;
}

export interface IntradayHrLayer {
  // Contiguous runs of points; a wear gap starts a new segment (see the gap note).
  segments: IntradayHrPoint[][];
  pointCount: number;
  min: number;
  max: number;
  zone2: { low: number; high: number } | null;
}

export interface IntradaySleepBlock {
  key: string;
  startMinute: number;
  endMinute: number;
  // True when the session extends beyond the rendered day — the block bleeds in
  // from (or off) the edge rather than pretending it started/ended at midnight.
  clippedStart: boolean;
  clippedEnd: boolean;
  stages: { stage: SleepStage; startMinute: number; endMinute: number }[];
}

export interface IntradayWorkoutBlock {
  key: string;
  eventId: string;
  anchorId: string;
  startMinute: number;
  endMinute: number;
  title: string;
  iconType: string | null;
  iconTitle: string | null;
  iconSportNames: string[] | null;
  href: TimelineEvent["href"];
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface IntradayTick {
  key: string;
  eventId: string;
  // The feed entry this tick points at — tapping the tick scrolls the list below
  // to that entry (chart as map, list as detail).
  anchorId: string;
  minute: number;
  label: string;
  category: TimelineCategory;
  tone: NonNullable<TimelineEvent["tone"]>;
}

// Categories the tick rail deliberately DROPS.
//
// `insight` (#1512 C): an AI insight is timestamped by the generation job's
// `created_at` (lib/timeline.ts), so it lands on the rail at whatever minute the
// job happened to run and clusters at whatever hour the tick fires. That minute
// says nothing about the person's day — it plots a MACHINE event beside
// physiological ones. The feed list below still shows the insight; the chart is a
// map of the day, not of the app's activity. Do not "helpfully" restore it.
const EXCLUDED_TICK_CATEGORIES: ReadonlySet<TimelineCategory> = new Set([
  "insight",
]);

export interface IntradayModel {
  date: string;
  minutesInDay: number;
  hr: IntradayHrLayer | null;
  sleep: IntradaySleepBlock[];
  workouts: IntradayWorkoutBlock[];
  ticks: IntradayTick[];
  nowMinute: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Minutes past midnight for an 'HH:MM' (or 'HH:MM:SS') wall time, or null when the
// string isn't a real clock time.
export function clockMinute(value: string | null | undefined): number | null {
  const m = /^(\d{2}):(\d{2})/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes from `date`'s local midnight to a local 'YYYY-MM-DDTHH:MM' stamp.
// Negative before the day, ≥1440 after it. Null when unparseable.
export function localStampMinute(date: string, stamp: string): number | null {
  const [stampDate, time] = stamp.split("T");
  const minute = clockMinute(time);
  if (minute == null || !/^\d{4}-\d{2}-\d{2}$/.test(stampDate)) return null;
  return dayOffset(date, stampDate) * MINUTES_IN_DAY + minute;
}

// Whole days from `from` to `to` (both YYYY-MM-DD). Small windows only — the
// callers compare a stamp against the rendered day, so the answer is ~[-2, 2];
// walking day-by-day keeps it pure calendar arithmetic with no Date parsing.
function dayOffset(from: string, to: string): number {
  if (from === to) return 0;
  for (let step = 1; step <= 3; step++) {
    if (shiftDateStr(from, step) === to) return step;
    if (shiftDateStr(from, -step) === to) return -step;
  }
  return to > from ? 3 : -3;
}

// Clip a [start, end) span to the rendered day, or null when nothing of it lands
// inside. Clipping NEVER re-attributes: a session that began yesterday keeps its
// real shape and simply enters from the left edge.
function clipToDay(
  startMinute: number,
  endMinute: number
): {
  startMinute: number;
  endMinute: number;
  clippedStart: boolean;
  clippedEnd: boolean;
} | null {
  if (!(endMinute > startMinute)) return null;
  if (endMinute <= 0 || startMinute >= MINUTES_IN_DAY) return null;
  return {
    startMinute: Math.max(0, startMinute),
    endMinute: Math.min(MINUTES_IN_DAY, endMinute),
    clippedStart: startMinute < 0,
    clippedEnd: endMinute > MINUTES_IN_DAY,
  };
}

// ── HR downsampling ──────────────────────────────────────────────────────────

// Collapse per-minute buckets into ≤288 five-minute points. The average is
// COUNT-WEIGHTED (hr_minutes.bpm is itself a count-weighted average of `n`
// samples), and the band keeps the true extremes of the merged minutes — a merge
// that averaged the min/max would shrink the band and understate a spike.
export function downsampleHr(
  date: string,
  buckets: IntradayHrBucket[],
  bucketMinutes = INTRADAY_BUCKET_MINUTES
): IntradayHrPoint[] {
  const width = Math.max(1, Math.trunc(bucketMinutes));
  const acc = new Map<
    number,
    { weight: number; sum: number; lo: number; hi: number }
  >();
  for (const b of buckets) {
    const minute = localStampMinute(date, b.ts);
    if (minute == null || minute < 0 || minute >= MINUTES_IN_DAY) continue;
    if (!Number.isFinite(b.bpm)) continue;
    const weight =
      b.n != null && Number.isFinite(b.n) && b.n > 0 ? Number(b.n) : 1;
    const lo =
      b.bpm_min != null && Number.isFinite(b.bpm_min) ? b.bpm_min : b.bpm;
    const hi =
      b.bpm_max != null && Number.isFinite(b.bpm_max) ? b.bpm_max : b.bpm;
    const slot = Math.floor(minute / width);
    const prev = acc.get(slot);
    if (prev) {
      prev.weight += weight;
      prev.sum += b.bpm * weight;
      prev.lo = Math.min(prev.lo, lo);
      prev.hi = Math.max(prev.hi, hi);
    } else {
      acc.set(slot, { weight, sum: b.bpm * weight, lo, hi });
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, v]) => {
      const bpm = Math.round((v.sum / v.weight) * 10) / 10;
      return {
        minute: slot * width,
        bpm,
        lo: Math.min(v.lo, bpm),
        hi: Math.max(v.hi, bpm),
      };
    });
}

// Split an ascending point list wherever the wear gap exceeds `gapMinutes`.
export function splitHrSegments(
  points: IntradayHrPoint[],
  gapMinutes = INTRADAY_GAP_MINUTES
): IntradayHrPoint[][] {
  const segments: IntradayHrPoint[][] = [];
  let current: IntradayHrPoint[] = [];
  for (const p of points) {
    const last = current[current.length - 1];
    if (last && p.minute - last.minute > gapMinutes) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

// ── The model ────────────────────────────────────────────────────────────────

// Build the day's intraday model, or NULL when nothing on the day is intraday —
// so an ordinary day (a weigh-in and a lab panel, none of them clock-timed, no HR,
// no sleep) renders no empty frame at all. Each layer is independently data-gated
// the same way.
export function buildIntradayModel(input: IntradayInput): IntradayModel | null {
  const points = downsampleHr(input.date, input.hr);
  const hr: IntradayHrLayer | null =
    points.length > 0
      ? {
          segments: splitHrSegments(points),
          pointCount: points.length,
          min: Math.min(...points.map((p) => p.lo)),
          max: Math.max(...points.map((p) => p.hi)),
          zone2: input.zone2,
        }
      : null;

  const sleep: IntradaySleepBlock[] = [];
  for (const span of input.sleep) {
    const clipped = clipToDay(span.startMinute, span.endMinute);
    if (!clipped) continue;
    const stages = (span.stages ?? []).flatMap((st) => {
      const c = clipToDay(st.startMinute, st.endMinute);
      return c
        ? [
            {
              stage: st.stage,
              startMinute: c.startMinute,
              endMinute: c.endMinute,
            },
          ]
        : [];
    });
    sleep.push({ key: span.key, ...clipped, stages });
  }
  sleep.sort((a, b) => a.startMinute - b.startMinute);

  const workouts: IntradayWorkoutBlock[] = [];
  const blockEventIds = new Set<string>();
  for (const event of input.events) {
    const w = event.clockWindow ? activityWindow(event.clockWindow) : null;
    if (!w) continue;
    const startMinute = localStampMinute(input.date, w.start);
    const endMinute = localStampMinute(input.date, w.end);
    if (startMinute == null || endMinute == null) continue;
    const clipped = clipToDay(startMinute, endMinute);
    if (!clipped) continue;
    blockEventIds.add(event.id);
    workouts.push({
      key: event.id,
      eventId: event.id,
      anchorId: timelineEntryAnchorId(event.id),
      ...clipped,
      title: event.title,
      iconType: event.iconType ?? null,
      iconTitle: event.iconTitle ?? null,
      iconSportNames: event.iconSportNames ?? null,
      href: event.href ?? null,
    });
  }
  workouts.sort((a, b) => a.startMinute - b.startMinute);

  // The tick rail: EVERY feed event that carries a clock time, isn't already drawn
  // as a block, and isn't in EXCLUDED_TICK_CATEGORIES (see that constant — the
  // exclusion is a decision, not an oversight). Events the feed shows with a day
  // granularity only (a weigh-in, a grouped lab panel, the day's dose roll-up)
  // carry no clock time and therefore contribute no tick — the layer is data-gated
  // like every other one, and the rail can never show something the list below
  // doesn't.
  const ticks: IntradayTick[] = [];
  for (const event of input.events) {
    if (blockEventIds.has(event.id)) continue;
    if (EXCLUDED_TICK_CATEGORIES.has(event.category)) continue;
    const minute = clockMinute(event.sortTime);
    if (minute == null) continue;
    ticks.push({
      key: event.id,
      eventId: event.id,
      anchorId: timelineEntryAnchorId(event.id),
      minute,
      label: event.title,
      category: event.category,
      tone: event.tone ?? "default",
    });
  }
  ticks.sort((a, b) => a.minute - b.minute || a.key.localeCompare(b.key));

  if (
    !hr &&
    sleep.length === 0 &&
    workouts.length === 0 &&
    ticks.length === 0
  ) {
    return null;
  }

  const nowMinute =
    input.nowMinute != null &&
    input.nowMinute >= 0 &&
    input.nowMinute <= MINUTES_IN_DAY
      ? input.nowMinute
      : null;

  return {
    date: input.date,
    minutesInDay: MINUTES_IN_DAY,
    hr,
    sleep,
    workouts,
    ticks,
    nowMinute,
  };
}
