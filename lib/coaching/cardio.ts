// Training coaching — cardio: speed derivation and cardio personal records.
// Pure and client-safe — no DB/network.
import { within, byDateDesc } from "./common";

// ---- Cardio ----

// Average speed in km/h, or null when distance or duration is missing/zero
// (can't derive a speed). Unit-agnostic, for comparison and ranking.
export function speedKmh(
  km: number | null | undefined,
  durationMin: number | null | undefined
): number | null {
  if (km == null || durationMin == null || km <= 0 || durationMin <= 0)
    return null;
  return km / (durationMin / 60);
}

// The three measurements a cardio record can be claimed on.
export type CardioRecordKind = "distance" | "speed" | "duration";
export const CARDIO_RECORD_KINDS: readonly CardioRecordKind[] = [
  "distance",
  "speed",
  "duration",
];

// What an activity's history actually EVIDENCES about one measurement (#2393).
// `measured` counts the sessions carrying that measurement — not the activity's
// sessions, which is the population the old gate asked about while the record was
// drawn from this one. `priorBest` is the best value among the sessions OTHER than
// the record-setting one: the number a record has to beat, and the only way to ask
// whether it beat it by anything material.
export interface CardioMeasurementEvidence {
  measured: number;
  priorBest: number; // 0 when nothing else carries the measurement
}

// Per-cardio-activity stats this module needs for PR detection.
export interface CardioSummary {
  activity: string;
  sessions: number;
  hasDistance: boolean; // any session logged a distance (else duration-only)
  longestDistanceKm: number;
  longestDistanceDate: string;
  fastestKmh: number; // 0 when no distance-and-duration session exists
  fastestKmhDate: string;
  longestDurationMin: number;
  longestDurationDate: string;
  // Per-measurement evidence, keyed by the record kind it backs (#2393).
  evidence: Record<CardioRecordKind, CardioMeasurementEvidence>;
}

export interface CardioPR {
  activity: string;
  kind: "distance" | "speed" | "duration";
  date: string;
  distanceKm: number;
  durationMin: number;
  speedKmh: number;
}

// ---- Materiality: what a cardio record must clear to be one (#2393) ----

// The measurement's own error, declared PER MEASUREMENT rather than as one global
// epsilon — GPS distance, elapsed duration and derived speed have different error
// characteristics, and derived speed compounds the other two. Same shape and same
// reasoning as `lib/biomarker-noise-floor` (#563): a move inside the instrument's
// error is noise, and reporting it as achievement devalues the real ones.
//
// `absolute` is in the measurement's own unit; `relative` is a fraction of the prior
// best, for an error that scales with the value. A declared 0 means "this half of
// the floor does not apply", with the reason stated beside it.
export interface CardioNoiseFloor {
  absolute: number;
  relative: number;
}

export const CARDIO_NOISE_FLOORS: Record<CardioRecordKind, CardioNoiseFloor> = {
  // 10 m. Consumer GNSS horizontal accuracy is ~5 m at 95% under open sky (the US
  // GPS Standard Positioning Service performance standard), and a route's total
  // distance carries at least the start and end errors, so a difference under ~10 m
  // is inside the measurement itself — the reported case was two walks 3 m apart,
  // both of which "set a record". No relative term: this is endpoint error, which
  // does not grow with route length in any way this model can honestly claim.
  distance: { absolute: 0.01, relative: 0 },
  // Speed is DERIVED from distance and duration, so its error compounds both. 1% of
  // the prior best is deliberately conservative — on a 5 km / 30 min session the two
  // floors below already imply ~3% — and it is a floor, not an error model.
  speed: { absolute: 0, relative: 0.01 },
  // 1 minute: durations are recorded in minutes and routinely entered rounded to
  // one, so a sub-minute gain is at the recording resolution. This is exactly
  // `biomarker-noise-floor`'s source 2 (resolution) applied to a duration.
  duration: { absolute: 1, relative: 0 },
};

// The floor a record of `kind` must beat, given the prior best it is measured against.
export function cardioNoiseFloor(
  kind: CardioRecordKind,
  priorBest: number
): number {
  const f = CARDIO_NOISE_FLOORS[kind];
  return Math.max(f.absolute, f.relative * Math.max(0, priorBest));
}

// A record asserts BEST EVER. When the measurement is missing from most of an
// activity's sessions the app does not know whether an unmeasured session was
// longer, so the claim cannot be made from the data. Coverage, not count: an
// activity measured from its very first session is fine on a short history.
export const CARDIO_COVERAGE_FLOOR = 0.5;

// Why a record that would otherwise have been claimed is not being claimed. The
// posture is `lib/freshness`'s: an unearned claim is WITHHELD with a stated reason,
// never silently folded into "nothing happened".
export type CardioWithheldReason =
  // Fewer than two sessions carry this measurement — there is no prior best to beat.
  | "no-measured-history"
  // The measurement is missing from most of the activity's sessions.
  | "sparse-measurement"
  // It beat the prior best by less than the measurement's own noise floor.
  | "within-noise";

export type CardioRecordVerdict =
  | { state: "record"; activity: string; kind: CardioRecordKind; pr: CardioPR }
  | {
      state: "withheld";
      activity: string;
      kind: CardioRecordKind;
      reason: CardioWithheldReason;
      date: string;
      value: number;
      priorBest: number;
    };

function prOf(
  activity: string,
  kind: CardioRecordKind,
  date: string,
  value: number
): CardioPR {
  return {
    activity,
    kind,
    date,
    distanceKm: kind === "distance" ? value : 0,
    durationMin: kind === "duration" ? value : 0,
    speedKmh: kind === "speed" ? value : 0,
  };
}

// Judge ONE measurement's best value against the evidence behind it. `sessions` is
// the activity's whole history; `ev.measured` the part of it carrying THIS
// measurement — the two used to disagree, which is how an activity with fourteen
// sessions and four distances set a distance record against a pool of four.
export function cardioRecordVerdict(
  activity: string,
  kind: CardioRecordKind,
  value: number,
  date: string,
  sessions: number,
  ev: CardioMeasurementEvidence
): CardioRecordVerdict {
  const withheld = (reason: CardioWithheldReason): CardioRecordVerdict => ({
    state: "withheld",
    activity,
    kind,
    reason,
    date,
    value,
    priorBest: ev.priorBest,
  });
  if (ev.measured < 2) return withheld("no-measured-history");
  if (sessions > 0 && ev.measured / sessions < CARDIO_COVERAGE_FLOOR)
    return withheld("sparse-measurement");
  if (value - ev.priorBest <= cardioNoiseFloor(kind, ev.priorBest))
    return withheld("within-noise");
  return {
    state: "record",
    activity,
    kind,
    pr: prOf(activity, kind, date, value),
  };
}

// Every cardio record CLAIM an activity's history raises inside the window, each
// either awarded or withheld with its reason. A measurement with no positive value,
// or whose best was set outside the window, raises no claim at all — nothing
// happened there, which is not the same as a claim being declined.
export function cardioRecordVerdicts(
  stats: CardioSummary[],
  today: string,
  withinDays = 30
): CardioRecordVerdict[] {
  const out: CardioRecordVerdict[] = [];
  for (const s of stats) {
    const candidates: {
      kind: CardioRecordKind;
      value: number;
      date: string;
    }[] = [
      {
        kind: "distance",
        value: s.longestDistanceKm,
        date: s.longestDistanceDate,
      },
      { kind: "speed", value: s.fastestKmh, date: s.fastestKmhDate },
      {
        kind: "duration",
        value: s.longestDurationMin,
        date: s.longestDurationDate,
      },
    ];
    for (const c of candidates) {
      if (!(c.value > 0)) continue;
      if (!within(c.date, today, withinDays)) continue;
      out.push(
        cardioRecordVerdict(
          s.activity,
          c.kind,
          c.value,
          c.date,
          s.sessions,
          s.evidence[c.kind]
        )
      );
    }
  }
  return out;
}

// Cardio records set within the last `withinDays`, newest first — the AWARDED half
// of `cardioRecordVerdicts`. Every record is claimed on the sessions carrying its
// own measurement, only when that measurement covers most of the activity's history,
// and only when it beat the prior best by more than the measurement's noise floor.
export function recentCardioPRs(
  stats: CardioSummary[],
  today: string,
  withinDays = 30
): CardioPR[] {
  return cardioRecordVerdicts(stats, today, withinDays)
    .flatMap((v) => (v.state === "record" ? [v.pr] : []))
    .sort(byDateDesc);
}
