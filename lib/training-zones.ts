// Training intensity distribution (issue #159) — PURE, client-safe zone math for
// the longevity/endurance view: HR zone boundaries, weekly minutes per zone from
// per-minute HR scoped to activity windows, weekly Zone 2 volume vs a target, and
// the easy/hard "polarization" split. No DB, no network — so it runs in the Trends
// section, the weekly recap, the coaching engine, and the unit tests alike.
//
// Zone boundaries are shown WITH their formula (no black box). Two methods:
//   • Karvonen (heart-rate reserve): target = restingHR + %HRR × (maxHR − restingHR).
//     Used when a resting HR is known — it personalizes the low end of every zone.
//   • % of max HR: target = %max × maxHR. The fallback when no resting HR exists.
// Max HR is a per-profile manual override when set (people who have a lab/field
// test), otherwise the age estimate maxHR = 208 − 0.7 × age (Tanaka). A lab-tested
// lactate/ventilatory threshold beats any formula — surfaces note this and the
// override is the escape hatch.

import { shiftDateStr, startOfWeekStr } from "./date";
import { weeklyChartWeeks } from "./weekly-fill";

// ---- Zone definitions ----

// Lower bound of each zone as a fraction (Z1..Z5). For Karvonen the fraction is
// of heart-rate RESERVE; for %-max it is of max HR. These are the widely-used
// 5-zone splits (50/60/70/80/90).
export const ZONE_LOWER_FRACTIONS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

export type ZoneId = 1 | 2 | 3 | 4 | 5;

export interface ZoneDef {
  id: ZoneId;
  name: string; // "Zone 2"
  label: string; // "Aerobic / endurance"
}

// The aerobic-threshold zone: Zone 2 is the top of the "easy" band. Zones at or
// below it are EASY (below the aerobic threshold); zones above it are HARD. This
// is the split the 80/20 polarized model tracks.
export const AEROBIC_THRESHOLD_ZONE: ZoneId = 2;

export const ZONES: readonly ZoneDef[] = [
  { id: 1, name: "Zone 1", label: "Recovery" },
  { id: 2, name: "Zone 2", label: "Aerobic / endurance" },
  { id: 3, name: "Zone 3", label: "Tempo" },
  { id: 4, name: "Zone 4", label: "Threshold" },
  { id: 5, name: "Zone 5", label: "VO2 max" },
] as const;

// Zone chart/legend colors — an easy→hard intensity ramp (blue → green → amber →
// orange → red). Plain data (no client deps) so both the server section (legend /
// boundary table) and the client chart share one source of truth. Indexed by
// zone id − 1.
export const ZONE_COLORS = [
  "#0ea5e9", // Z1 sky-500 (recovery)
  "#16a34a", // Z2 green-600 (aerobic — the Zone 2 base)
  "#eab308", // Z3 yellow-500 (tempo)
  "#f97316", // Z4 orange-500 (threshold)
  "#ef4444", // Z5 red-500 (VO2 max)
] as const;

// ---- Max HR resolution ----

export type MaxHrSource = "override" | "estimated";

// Age-estimated max HR (Tanaka 2001): 208 − 0.7 × age. Rounded to a whole bpm.
export function estimateMaxHr(age: number): number {
  return Math.round(208 - 0.7 * age);
}

// Resolve the max HR to use: a valid manual override wins (the person knows theirs
// from a test); otherwise the age estimate. Returns null when neither is available
// (no zones can be drawn) so callers degrade to an explanatory empty state.
export function resolveMaxHr(opts: {
  override?: number | null;
  age?: number | null;
}): { maxHr: number; source: MaxHrSource } | null {
  const ov = opts.override;
  if (ov != null && Number.isFinite(ov) && ov > 0) {
    return { maxHr: Math.round(ov), source: "override" };
  }
  const age = opts.age;
  if (age != null && Number.isFinite(age) && age > 0) {
    return { maxHr: estimateMaxHr(age), source: "estimated" };
  }
  return null;
}

// ---- Zone model ----

export type ZoneMethod = "karvonen" | "percent-max";

export interface ZoneModel {
  method: ZoneMethod;
  maxHr: number;
  restingHr: number | null;
  maxHrSource: MaxHrSource;
  // Lower bpm bound of each zone 1..5 (5 entries, ascending). A bpm at or above
  // lowerBounds[4] is Zone 5; below lowerBounds[1] is clamped into Zone 1.
  lowerBounds: number[];
  // Human-readable formula string for the "no black box" note.
  formula: string;
}

// Build the zone model from age / resting HR / manual override. Returns null when
// no max HR can be resolved (no age and no override). Karvonen is used when a
// plausible resting HR (0 < resting < maxHr) is present; otherwise %-of-max.
export function buildZoneModel(opts: {
  age?: number | null;
  restingHr?: number | null;
  maxHrOverride?: number | null;
}): ZoneModel | null {
  const res = resolveMaxHr({ override: opts.maxHrOverride, age: opts.age });
  if (!res) return null;
  const { maxHr, source } = res;

  const rest = opts.restingHr;
  const resting =
    rest != null && Number.isFinite(rest) && rest > 0 && rest < maxHr
      ? Math.round(rest)
      : null;
  const method: ZoneMethod = resting != null ? "karvonen" : "percent-max";

  const lowerBounds = ZONE_LOWER_FRACTIONS.map((f) =>
    method === "karvonen"
      ? Math.round(resting! + f * (maxHr - resting!))
      : Math.round(f * maxHr)
  );

  const formula =
    method === "karvonen"
      ? `Karvonen (heart-rate reserve): target = resting HR + %HRR × (max HR − resting HR). Resting ${resting} bpm, max ${maxHr} bpm.`
      : `% of max HR: target = %max × max HR. Max ${maxHr} bpm.`;

  return {
    method,
    maxHr,
    restingHr: resting,
    maxHrSource: source,
    lowerBounds,
    formula,
  };
}

// The zone a single bpm reading falls into. Below Zone 2's floor clamps to Zone 1
// (still training minutes, just easy); above Zone 5's floor clamps to Zone 5.
export function zoneForBpm(bpm: number, model: ZoneModel): ZoneId {
  const b = model.lowerBounds;
  if (bpm >= b[4]) return 5;
  if (bpm >= b[3]) return 4;
  if (bpm >= b[2]) return 3;
  if (bpm >= b[1]) return 2;
  return 1;
}

// ---- Activity-window scoping ----

// One per-minute HR bucket (hr_minutes row), ts a profile-local "YYYY-MM-DDTHH:MM".
export interface HrBucket {
  ts: string;
  bpm: number;
}

// A local time window [start, end) in the SAME "YYYY-MM-DDTHH:MM" form as HrBucket.ts.
export interface ActivityWindow {
  start: string;
  end: string;
}

// The activity fields needed to bound a training window. start_time / end_time are
// "HH:MM" local; duration_min is the fallback end when no end_time is stored.
export interface ActivityWindowInput {
  date: string; // YYYY-MM-DD (profile-local)
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  duration_min: number | null;
}

// Add whole minutes to a local "YYYY-MM-DDTHH:MM", rolling the date across
// midnight. Pure string/calendar arithmetic (shiftDateStr is UTC-anchored), so no
// timezone drift.
function addMinutesLocal(local: string, add: number): string {
  const [date, time] = local.split("T");
  const [h, m] = time.split(":").map(Number);
  let total = h * 60 + m + add;
  let d = date;
  while (total >= 1440) {
    total -= 1440;
    d = shiftDateStr(d, 1);
  }
  while (total < 0) {
    total += 1440;
    d = shiftDateStr(d, -1);
  }
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${d}T${hh}:${mm}`;
}

// The local time window an activity occupies, or null when it can't be bounded
// (no start time, or no end derivable from end_time / duration). Only WINDOWED
// activities count — that's the whole point: all-day wear data outside any workout
// must never be scored as training. When end_time is at/before start_time it is
// treated as a next-day rollover (a session that crossed midnight).
export function activityWindow(a: ActivityWindowInput): ActivityWindow | null {
  if (!a.start_time) return null;
  const start = `${a.date}T${a.start_time.slice(0, 5)}`;
  let end: string | null = null;
  if (a.end_time) {
    end = `${a.date}T${a.end_time.slice(0, 5)}`;
    if (end <= start) end = addMinutesLocal(end, 1440); // crossed midnight
  } else if (a.duration_min != null && a.duration_min > 0) {
    end = addMinutesLocal(start, Math.round(a.duration_min));
  }
  if (!end || end <= start) return null;
  return { start, end };
}

// The set of bounded windows for a list of activities (unbounded ones dropped).
export function activityWindows(
  activities: ActivityWindowInput[]
): ActivityWindow[] {
  const out: ActivityWindow[] = [];
  for (const a of activities) {
    const w = activityWindow(a);
    if (w) out.push(w);
  }
  return out;
}

export function inAnyWindow(ts: string, windows: ActivityWindow[]): boolean {
  return windows.some((w) => ts >= w.start && ts < w.end);
}

// Keep only the HR buckets that fall inside some activity window.
export function scopeBucketsToWindows(
  buckets: HrBucket[],
  windows: ActivityWindow[]
): HrBucket[] {
  if (windows.length === 0) return [];
  return buckets.filter((b) => inAnyWindow(b.ts, windows));
}

// ---- Aggregations ----

// Minutes in each zone (index 0 = Zone 1 … index 4 = Zone 5) for a week.
export interface WeeklyZoneMinutes {
  week: string; // week-start YYYY-MM-DD (profile week-start)
  minutes: number[]; // length 5
  total: number;
}

function emptyZones(): number[] {
  return [0, 0, 0, 0, 0];
}

// Weekly minutes per zone from window-scoped buckets. Each bucket is one minute in
// the zone of its bpm. Weeks are keyed by the profile's configured week-start day
// (startOfWeekStr) so boundaries follow the same convention as every other weekly
// view. Returned oldest→newest; only weeks with data appear.
export function weeklyZoneMinutes(
  scoped: HrBucket[],
  model: ZoneModel,
  weekStart = 0
): WeeklyZoneMinutes[] {
  const byWeek = new Map<string, number[]>();
  for (const b of scoped) {
    const day = b.ts.slice(0, 10);
    const wk = startOfWeekStr(day, weekStart);
    let arr = byWeek.get(wk);
    if (!arr) byWeek.set(wk, (arr = emptyZones()));
    arr[zoneForBpm(b.bpm, model) - 1] += 1;
  }
  return [...byWeek.keys()].sort().map((week) => {
    const minutes = byWeek.get(week)!;
    return { week, minutes, total: minutes.reduce((s, n) => s + n, 0) };
  });
}

// Zero-fill the gaps in a weekly-zone series so a training pause renders as empty
// weeks, not a compressed-away gap (issue #406). weeklyZoneMinutes emits only weeks
// WITH data; this expands to the contiguous week axis (window-bounded via
// weeklyChartWeeks), inserting an all-zero WeeklyZoneMinutes for every missing
// week. Input weeks are matched by their week-start key; extra data weeks outside
// the window are dropped by the axis. Pure — the DB layer feeds it and the section
// maps the result.
export function fillZoneWeeks(
  rows: WeeklyZoneMinutes[],
  windowWeeks: number
): WeeklyZoneMinutes[] {
  if (rows.length === 0) return [];
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  return weeklyChartWeeks([...byWeek.keys()], windowWeeks).map(
    (week) => byWeek.get(week) ?? { week, minutes: emptyZones(), total: 0 }
  );
}

// Total minutes in each zone (index 0 = Zone 1 … 4 = Zone 5) across all buckets,
// ignoring week boundaries. Used for a single-window Zone 2 total (weekly recap).
export function zoneMinuteTotals(
  scoped: HrBucket[],
  model: ZoneModel
): number[] {
  const totals = emptyZones();
  for (const b of scoped) totals[zoneForBpm(b.bpm, model) - 1] += 1;
  return totals;
}

// Zone 2 minutes for a single week row (0 when absent).
export function zone2Minutes(row: WeeklyZoneMinutes | undefined): number {
  return row ? row.minutes[AEROBIC_THRESHOLD_ZONE - 1] : 0;
}

export interface Zone2Adherence {
  minutes: number;
  target: number;
  met: boolean;
  pct: number; // 0..100+, minutes/target as a percentage (0 when no target)
}

// Zone 2 volume vs the configurable weekly target.
export function zone2Adherence(
  minutes: number,
  target: number
): Zone2Adherence {
  const t = target > 0 ? target : 0;
  return {
    minutes,
    target: t,
    met: t > 0 ? minutes >= t : false,
    pct: t > 0 ? Math.round((minutes / t) * 100) : 0,
  };
}

// The easy/hard split over a set of window-scoped buckets. Easy = zones at or
// below the aerobic-threshold zone (Z1–Z2); hard = above it (Z3–Z5).
export interface PolarizedSplit {
  easyMin: number;
  hardMin: number;
  totalMin: number;
  easyPct: number; // rounded, 0 when no data
  hardPct: number; // rounded, 0 when no data
}

export function polarizedSplit(
  scoped: HrBucket[],
  model: ZoneModel
): PolarizedSplit {
  let easy = 0;
  let hard = 0;
  for (const b of scoped) {
    if (zoneForBpm(b.bpm, model) <= AEROBIC_THRESHOLD_ZONE) easy += 1;
    else hard += 1;
  }
  const total = easy + hard;
  return {
    easyMin: easy,
    hardMin: hard,
    totalMin: total,
    easyPct: total > 0 ? Math.round((easy / total) * 100) : 0,
    hardPct: total > 0 ? Math.round((hard / total) * 100) : 0,
  };
}

// ---- Polarization verdict (drives the coaching nudge) ----

// The polarized "80/20" model wants ~80% easy. We flag HARD-HEAVY when the hard
// share climbs past this and there's enough volume to be meaningful — the classic
// self-coached failure mode of turning every easy day into a moderate grind.
export const POLARIZATION_HARD_PCT_LIMIT = 35;
export const POLARIZATION_MIN_MINUTES = 90;

export type PolarizationVerdict =
  "hard-heavy" | "balanced" | "insufficient-data";

export function classifyPolarization(
  split: PolarizedSplit
): PolarizationVerdict {
  if (split.totalMin < POLARIZATION_MIN_MINUTES) return "insufficient-data";
  if (split.hardPct > POLARIZATION_HARD_PCT_LIMIT) return "hard-heavy";
  return "balanced";
}
