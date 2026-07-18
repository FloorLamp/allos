// Endurance event plans — the PURE trajectory engine (issue #839).
//
// A profile's `endurance_plans` row stores only the GOAL: an event date, a
// discipline (run/ride/swim), a target distance, an optional target time. This
// module derives, from (event date, target distance, CURRENT logged weekly volume),
// a week-by-week VOLUME trajectory with the classic public-domain endurance-training
// guardrails — never a canned program, never stored. Because the trajectory is a
// pure function of the CURRENT actual weekly volume, re-running it each week
// projects from reality: a missed week lowers the base and the remaining weeks
// auto-adjust (no "you failed week 3" debt accounting).
//
// ── Cited guardrails (general, public-domain training principles — NOT a copyrighted
//    plan table) ────────────────────────────────────────────────────────────────
//   • The "ten percent rule": weekly training volume should climb by no more than
//     ~10% week over week, to bound overuse-injury risk. (Widely-cited running
//     guideline; the reference safe ramp rate.)
//   • A designated weekly LONG session grows toward a distance-appropriate peak, but
//     stays a bounded fraction of the week's volume so one session doesn't dominate
//     load.
//   • A recovery ("cutback"/"step-back") week every 3–4 weeks: volume steps DOWN to
//     let adaptation catch up, then the progression resumes from the pre-cutback
//     level. (Classic mesocycle cadence — composes with, doesn't duplicate, the
//     strength-side mesocycle concepts.)
//   • A distance-scaled TAPER window before the event (1 week for short races, up to
//     ~3 for marathon-plus): volume reduces progressively so the athlete arrives
//     fresh.
//   • INFEASIBLE-DATE HONESTY: if (date, distance, current volume) can't be
//     reconciled by a SAFE (≤10%/week) ramp, the engine SAYS so and shows the safe
//     trajectory and where it lands — it never fabricates an unsafe ramp.
//
// Pure: no DB/network. The gather (current weekly volume from getCardioVolumeByWeek's
// distance sibling, long-session detection over logged sessions) lives in the query
// layer; this file is exhaustively unit-tested at the boundaries.

export type EndurancePlanDiscipline = "run" | "ride" | "swim";
export type EndurancePlanStatus = "active" | "completed" | "abandoned";

// A stored plan row (the goal only — the trajectory is never persisted).
export interface EndurancePlan {
  id: number;
  eventName: string | null;
  discipline: EndurancePlanDiscipline;
  eventDate: string; // YYYY-MM-DD
  targetDistanceKm: number;
  targetTimeSec: number | null;
  status: EndurancePlanStatus;
  notes: string | null;
  completedOn: string | null;
}

export const ENDURANCE_DISCIPLINES: readonly EndurancePlanDiscipline[] = [
  "run",
  "ride",
  "swim",
];

export function isEnduranceDiscipline(s: string): s is EndurancePlanDiscipline {
  return (ENDURANCE_DISCIPLINES as readonly string[]).includes(s);
}

// ---- Cited constants ----

// The ten-percent rule: max safe week-over-week volume increase.
export const MAX_WEEKLY_RAMP = 0.1;

// A long session should stay ≤ this fraction of the week's volume (a long run much
// past ~40% of weekly mileage over-concentrates load). Also converts a desired peak
// long session into the weekly volume needed to support it.
export const LONG_SESSION_FRACTION = 0.4;

// A recovery/cutback week every N build weeks; its volume is CUTBACK× the prior
// progression level and the progression does not advance that week.
export const RECOVERY_CADENCE_WEEKS = 4;
export const RECOVERY_CUTBACK = 0.8;

// The distance-appropriate PEAK long session, by discipline: the run cap reflects
// that a marathon is never rehearsed at full distance (the classic ~32 km long-run
// ceiling); ride/swim rehearse toward the full event distance, so their cap only
// bites at ultra distances.
const LONG_SESSION_CAP_KM: Record<EndurancePlanDiscipline, number> = {
  run: 32,
  ride: 200,
  swim: 10,
};

// The taper window (weeks) scales with event distance.
export function taperWeeksForDistance(distanceKm: number): number {
  if (distanceKm < 16) return 1; // 5k–10k
  if (distanceKm < 32) return 2; // half / metric distances
  return 3; // marathon+
}

// The distance-appropriate peak long session for a discipline + target distance:
// grows TOWARD the event distance, capped by the discipline ceiling.
export function peakLongSessionKm(
  discipline: EndurancePlanDiscipline,
  targetDistanceKm: number
): number {
  return Math.min(targetDistanceKm, LONG_SESSION_CAP_KM[discipline]);
}

// ---- Trajectory ----

export type EnduranceWeekPhase = "build" | "recovery" | "taper" | "event";

export interface EnduranceWeek {
  // 0-based week index from THIS week (index 0) to the event week.
  index: number;
  // The prescribed weekly volume (km) and the week's long-session target (km).
  targetVolumeKm: number;
  longSessionKm: number;
  phase: EnduranceWeekPhase;
  isRecoveryWeek: boolean;
  isTaper: boolean;
}

export interface EnduranceTrajectory {
  // False ⇒ the event is too soon for a safe ramp from the current volume; `weeks`
  // still holds the SAFE trajectory (10%-capped) and `projectedPeakVolumeKm` /
  // `projectedPeakLongKm` say where it lands. `message` explains, honestly.
  feasible: boolean;
  weeks: EnduranceWeek[];
  weeksToEvent: number;
  // The peak weekly volume the goal implies (to support the peak long session).
  neededPeakVolumeKm: number;
  peakLongSessionKm: number;
  // What the SAFE trajectory actually reaches by the event (== needed when feasible).
  projectedPeakVolumeKm: number;
  projectedPeakLongKm: number;
  // A one-line honest summary (feasible or not) the surfaces render verbatim.
  message: string;
}

export interface EnduranceTrajectoryInput {
  today: string; // YYYY-MM-DD (profile tz)
  eventDate: string; // YYYY-MM-DD
  discipline: EndurancePlanDiscipline;
  targetDistanceKm: number;
  // Current weekly volume (km) — the last COMPLETED week's logged distance for the
  // discipline. The trajectory projects forward from this, so it recomputes from
  // actuals each week.
  currentWeeklyVolumeKm: number;
  // First weekday of the profile's week (0=Sun), for the week-boundary math.
  weekStart?: number;
}

// Whole weeks between two YYYY-MM-DD week-starts (b - a), or 0 if unparseable.
function weeksBetween(aWeekStart: string, bWeekStart: string): number {
  const a = Date.parse(`${aWeekStart}T00:00:00Z`);
  const b = Date.parse(`${bWeekStart}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / (7 * 86_400_000));
}

// Start-of-week for a date (self-contained so the engine stays pure/importable).
function startOfWeek(dateStr: string, weekStart: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) return dateStr;
  const d = new Date(t);
  const dow = d.getUTCDay();
  const delta = (dow - weekStart + 7) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Taper reduction factor for the pos-th taper week (0-based) of `count` weeks:
// steps down from ~0.7 of peak toward ~0.4.
function taperFactor(pos: number): number {
  return Math.max(0.4, 0.7 - pos * 0.15);
}

// The core: derive the weekly trajectory. Always projects from the CURRENT actual
// volume (recompute-from-actuals), applies the 10% ramp cap, inserts recovery weeks,
// and a distance-scaled taper; if the date is too soon it returns feasible=false
// with the safe trajectory (never an unsafe ramp).
export function computeEnduranceTrajectory(
  input: EnduranceTrajectoryInput
): EnduranceTrajectory {
  const weekStart = input.weekStart ?? 0;
  const todayWeek = startOfWeek(input.today, weekStart);
  const eventWeek = startOfWeek(input.eventDate, weekStart);
  const eventWeekIndex = Math.max(0, weeksBetween(todayWeek, eventWeek));

  const peakLong = peakLongSessionKm(input.discipline, input.targetDistanceKm);
  // Weekly volume needed to support the peak long session (never below current).
  const base = Math.max(input.currentWeeklyVolumeKm, 0);
  const neededPeak = Math.max(base, peakLong / LONG_SESSION_FRACTION);

  const taperWeeks = taperWeeksForDistance(input.targetDistanceKm);
  // Taper occupies the last `taperWeeks` weeks before the event week (clamped so a
  // near-term event doesn't produce negative build weeks).
  const taperStartIndex = Math.max(0, eventWeekIndex - taperWeeks);

  // Effective base for the ramp math — a profile with ~no logged volume can't ramp
  // from zero, so floor the projection at a nominal 1 km while feasibility below
  // reflects the true (possibly zero) starting point.
  const effectiveBase = Math.max(base, 1);

  const weeks: EnduranceWeek[] = [];
  let level = effectiveBase; // last-reached progression volume
  let peakReached = effectiveBase;
  let peakLongReached = 0;

  for (let i = 0; i < eventWeekIndex; i++) {
    let phase: EnduranceWeekPhase;
    let target: number;
    let isRecovery = false;
    const isTaper = i >= taperStartIndex;

    if (isTaper) {
      phase = "taper";
      target = peakReached * taperFactor(i - taperStartIndex);
    } else {
      // A recovery week every RECOVERY_CADENCE_WEEKS build weeks (weeks 4, 8, …),
      // but never week 0 and never when the build is too short to have cycled.
      isRecovery =
        i > 0 && (i + 1) % RECOVERY_CADENCE_WEEKS === 0 && i >= RECOVERY_CADENCE_WEEKS - 1;
      if (isRecovery) {
        phase = "recovery";
        target = level * RECOVERY_CUTBACK; // level unchanged — resumes next week
      } else {
        phase = "build";
        level = Math.min(neededPeak, level * (1 + MAX_WEEKLY_RAMP));
        target = level;
        if (level > peakReached) peakReached = level;
      }
    }

    const longSession = Math.min(peakLong, target * LONG_SESSION_FRACTION);
    if (longSession > peakLongReached) peakLongReached = longSession;

    weeks.push({
      index: i,
      targetVolumeKm: round1(target),
      longSessionKm: round1(longSession),
      phase,
      isRecoveryWeek: isRecovery,
      isTaper,
    });
  }

  // The event week itself: the event IS the session — volume/long session == the
  // race distance (bounded by the discipline long cap for display sanity).
  weeks.push({
    index: eventWeekIndex,
    targetVolumeKm: round1(input.targetDistanceKm),
    longSessionKm: round1(input.targetDistanceKm),
    phase: "event",
    isRecoveryWeek: false,
    isTaper: false,
  });

  // Feasibility: how many BUILD weeks the safe ramp needs to climb base → neededPeak
  // vs how many are available before the taper. A zero starting volume is never
  // feasible (nothing to ramp from).
  const availableBuildWeeks = taperStartIndex;
  const ratio = neededPeak / effectiveBase;
  const progressionSteps =
    ratio <= 1 ? 0 : Math.ceil(Math.log(ratio) / Math.log(1 + MAX_WEEKLY_RAMP));
  // Add the recovery weeks the ramp would incur (one per RECOVERY_CADENCE-1
  // progression weeks).
  const neededBuildWeeks =
    progressionSteps +
    Math.floor(progressionSteps / (RECOVERY_CADENCE_WEEKS - 1));
  const feasible =
    base > 0 && availableBuildWeeks >= neededBuildWeeks && eventWeekIndex > 0;

  const projectedPeakVolume = round1(peakReached);
  const projectedPeakLong = round1(peakLongReached);

  const message = buildMessage({
    feasible,
    discipline: input.discipline,
    targetDistanceKm: input.targetDistanceKm,
    weeksToEvent: eventWeekIndex,
    currentWeeklyVolumeKm: round1(base),
    neededPeakVolumeKm: round1(neededPeak),
    projectedPeakVolumeKm: projectedPeakVolume,
    projectedPeakLongKm: projectedPeakLong,
  });

  return {
    feasible,
    weeks,
    weeksToEvent: eventWeekIndex,
    neededPeakVolumeKm: round1(neededPeak),
    peakLongSessionKm: round1(peakLong),
    projectedPeakVolumeKm: projectedPeakVolume,
    projectedPeakLongKm: projectedPeakLong,
    message,
  };
}

function buildMessage(a: {
  feasible: boolean;
  discipline: EndurancePlanDiscipline;
  targetDistanceKm: number;
  weeksToEvent: number;
  currentWeeklyVolumeKm: number;
  neededPeakVolumeKm: number;
  projectedPeakVolumeKm: number;
  projectedPeakLongKm: number;
}): string {
  const wk = a.weeksToEvent;
  if (wk <= 0) return "Event week — this is it. Trust the taper and race.";
  const wks = `${wk} week${wk === 1 ? "" : "s"}`;
  if (a.feasible) {
    return `${wks} to the event — the safe trajectory peaks around ${a.neededPeakVolumeKm} km/week (long session ~${a.projectedPeakLongKm} km) before a taper.`;
  }
  return `${wks} is short for a ${round1(a.targetDistanceKm)} km ${a.discipline} from ${a.currentWeeklyVolumeKm} km/week. Here's the SAFE trajectory anyway — it peaks around ${a.projectedPeakVolumeKm} km/week (long session ~${a.projectedPeakLongKm} km), short of the ~${a.neededPeakVolumeKm} km/week the goal implies. Consider a later date or a shorter distance.`;
}

// ---- Long-session detection (pure) ----

// One logged session in a week, for long-session detection.
export interface LoggedSession {
  distanceKm: number;
  // Strava's workout_type label where present ("long run", "race", …). Null for
  // manually-logged or unlabeled sessions.
  workoutType: string | null;
}

// The week's LONG session distance (km). Reuses Strava's long-run/race labeling
// where present (the labeled session's distance), else falls back to the
// longest-distance session of the week. Returns 0 when nothing is logged.
export function detectLongSessionKm(sessions: readonly LoggedSession[]): number {
  if (sessions.length === 0) return 0;
  const labeled = sessions.filter((s) => {
    const t = (s.workoutType ?? "").toLowerCase();
    return t === "long run" || t === "race";
  });
  const pool = labeled.length > 0 ? labeled : sessions;
  return round1(Math.max(...pool.map((s) => s.distanceKm)));
}
