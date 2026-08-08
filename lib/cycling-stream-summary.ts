// The two questions the CYCLING OVERVIEW asks of a ride's telemetry, and the
// small answer it stores beside the streams so it never has to ask them again.
//
// WHY THIS EXISTS (#2292). `getCyclingOverviewData` used to read every
// `activity_telemetry.streams_json` row for the profile and JSON.parse each one,
// on every load of Training → Analyze → Cycling. Streams are the largest payload
// the schema carries — per-second samples for a whole ride — so that page's cost
// scaled with total ride history IN BYTES PARSED, not rows returned. It degrades
// faster than a row-count scan and is invisible in a query-count metric.
//
// The overview derives exactly two things from those streams, and NOTHING else:
//
//   1. the power curve — the best rolling mean at each POWER_CURVE_DURATIONS
//      duration, reduced across rides into all-time bests;
//   2. seconds in each power zone, summed across rides.
//
// (Its other telemetry-derived values — training load, the latest FTP snapshot,
// the sensor-trace count — come from `ftp_w` and the row's existence, and never
// touched the streams at all.)
//
// Both are pure functions of the telemetry row's OWN columns — `streams_json` and
// `power_zones_json` — and of nothing on the activity row. That is the invariant
// this whole design rests on: it is why a summary computed once at ingest stays
// correct for the life of the row, and why re-pointing a row at another activity
// (lib/merge-activity.ts) or restoring one (lib/undo-delete.ts) cannot invalidate
// it. A future writer of `activity_telemetry` must either write a summary through
// `summarizeCyclingStreams` or leave the column NULL for the boot reconcile in
// lib/cycling-stream-summary-db.ts to fill.
//
// WHY NOT WINDOW THE READ, the way #2197/PR #2290 bounded the per-minute HR read
// on this very same page. Because these two values are ALL-TIME CLAIMS and the HR
// distribution was not. The power card's own copy is "Personal best rolling
// efforts": bound it to a training block and the card keeps saying "Personal best"
// while meaning "best since March", and "Time in power zones" stops describing the
// history that "Data coverage … across your history" sits next to. There is no
// honest re-wording that keeps those cards doing their job, so the two reads on
// this page now have DELIBERATELY DIFFERENT answers — windowed for the HR
// distribution, precomputed-and-all-time here. That is a decision, not an
// inconsistency someone should tidy up.

import {
  parseCyclingStreams,
  powerCurve,
  powerZoneTimes,
  POWER_CURVE_DURATIONS,
  type PowerZoneRange,
} from "./cycling-analytics";

// Bump when the DERIVATION LOGIC changes — how a rolling mean is taken, how a
// sample's interval is attributed to a zone. The DURATIONS are folded into the
// signature automatically below, so adding a 30-second bucket needs no bump here.
//
// v1: initial summary (#2292) — power curve bests and per-zone seconds.
export const STREAM_SUMMARY_LOGIC_VERSION = 1;

// What a stored summary must say to be believed. Anything else — an older logic
// version, a curve taken at durations the app no longer shows — is treated as
// absent, and lib/cycling-stream-summary-db.ts re-derives it on the next boot.
// Short and readable on purpose: it is stamped onto every telemetry row.
export function streamSummarySignature(): string {
  return `${STREAM_SUMMARY_LOGIC_VERSION}:${POWER_CURVE_DURATIONS.map(
    (d) => d.seconds
  ).join(",")}`;
}

export interface CyclingStreamSummary {
  sig: string;
  // Best rolling mean per duration. `seconds` keys back into
  // POWER_CURVE_DURATIONS for its label — presentation text is re-attached on
  // read, never frozen into a stored row.
  powerCurve: { seconds: number; watts: number }[];
  // Seconds in each power zone, by zone index. Empty when the row carries no
  // zone snapshot or no usable power samples.
  powerZoneSeconds: number[];
}

// The telemetry row's stored power-zone bands. Moved here from the ride query
// layer so ingest, the boot reconcile and the ride-detail read all parse the
// snapshot the same way.
export function parsePowerZones(value: string | null): PowerZoneRange[] {
  if (!value) return [];
  try {
    const zones = JSON.parse(value);
    if (!Array.isArray(zones)) return [];
    return zones.flatMap((zone) => {
      if (!zone || typeof zone !== "object") return [];
      const rec = zone as Record<string, unknown>;
      const valueOrNull = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      return [{ min: valueOrNull(rec.min), max: valueOrNull(rec.max) }];
    });
  } catch {
    return [];
  }
}

// TOTAL over its inputs: a NULL, empty or malformed `streams_json` summarises to
// an empty-but-SIGNED summary rather than throwing or returning null. That is
// what gives an unsummarisable row a terminal state — it is written once, stops
// matching the reconcile's WHERE, and is never re-parsed on a later boot.
export function summarizeCyclingStreams(
  streamsJson: string | null,
  powerZonesJson: string | null
): CyclingStreamSummary {
  const streams = parseCyclingStreams(streamsJson);
  return {
    sig: streamSummarySignature(),
    powerCurve: powerCurve(streams).map(({ seconds, watts }) => ({
      seconds,
      watts,
    })),
    powerZoneSeconds: powerZoneTimes(
      streams,
      parsePowerZones(powerZonesJson)
    ).map((zone) => zone.seconds),
  };
}

export function serializeCyclingStreamSummary(
  summary: CyclingStreamSummary
): string {
  return JSON.stringify(summary);
}

// The one place a stored summary is trusted or refused. Returns null for a row
// that has none, carries a stale signature, or is unreadable — callers treat that
// as "this ride contributes nothing", never as a reason to fall back to parsing
// the streams, which is the cost this whole change exists to remove.
export function parseCyclingStreamSummary(
  value: string | null
): CyclingStreamSummary | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.sig !== streamSummarySignature()) return null;
  const curve = Array.isArray(rec.powerCurve) ? rec.powerCurve : [];
  const zoneSeconds = Array.isArray(rec.powerZoneSeconds)
    ? rec.powerZoneSeconds
    : [];
  return {
    sig: rec.sig,
    powerCurve: curve.flatMap((point) => {
      if (!point || typeof point !== "object") return [];
      const p = point as Record<string, unknown>;
      return typeof p.seconds === "number" && typeof p.watts === "number"
        ? [{ seconds: p.seconds, watts: p.watts }]
        : [];
    }),
    powerZoneSeconds: zoneSeconds.map((seconds) =>
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0
    ),
  };
}
