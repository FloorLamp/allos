// THE UNIFIED READING SERIES (#1997 phase 1) — the query half of
// lib/reading-model.ts.
//
// Ask for a QUANTITY (a #482 identity) and get every reading of it, from whichever
// stores physically hold its rows, in one shape. Nothing here changes storage: it
// is presentation over the existing tables, so every store-specific reader keeps
// working and no migration is involved.
//
// ONE COMPUTATION, NOT A SECOND SERIES ENGINE. The observation half delegates to
// `getBiomarkerSeries`, which already resolves the family identity and applies the
// cross-source de-dup CTE — so a folded observation series is byte-for-byte the one
// the biomarker surfaces read, never a parallel realization of it. (The identity is
// a fixed point of `biomarkerFamily`, so passing an identity where that reader
// expects a canonical name resolves the same family.)
//
// Auth-blind and profile-scoped, like every reader here: `profileId` first, no
// `lib/auth` import, and every statement filters on `profile_id`.

import { db, readTx } from "../db";
import { getBiomarkerSeries } from "./medical";
import { metricObservationFoldIdentity } from "../metric-judgment";
import type { BodyMetricSlug } from "../trends-body-metrics";
import {
  dedupeReadings,
  readingFromBodyMetric,
  readingFromMetricSample,
  readingFromObservation,
  sortReadings,
  streamSourcesForIdentity,
  type Reading,
  type StreamReadingSource,
} from "../reading-model";
import type { BodyMetricColumn } from "../metric-readings";

// body_metrics is the one store whose COLUMN varies by reading, and interpolating
// that column would make the statement unreadable to the profile-scoping scanner
// (it verifies `profile_id` in LITERAL prepare() text). So each column gets its own
// literal statement — the same deliberate verbosity lib/metric-readings.ts keeps in
// the layer that decides whose rows you see.
function bodyMetricReadingSelect(column: BodyMetricColumn) {
  switch (column) {
    case "weight_kg":
      return db.prepare(
        `SELECT id, date, weight_kg AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND weight_kg IS NOT NULL
          ORDER BY date ASC, id ASC`
      );
    case "body_fat_pct":
      return db.prepare(
        `SELECT id, date, body_fat_pct AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND body_fat_pct IS NOT NULL
          ORDER BY date ASC, id ASC`
      );
    case "resting_hr":
      return db.prepare(
        `SELECT id, date, resting_hr AS value, source, edited, notes FROM body_metrics
          WHERE profile_id = ? AND resting_hr IS NOT NULL
          ORDER BY date ASC, id ASC`
      );
  }
}

/**
 * Every reading one STREAM source holds for a profile, presented as `Reading`s.
 *
 * Exported because the stream half is a legitimate question on its own ("what does
 * the device stream say?"), and because it keeps the metric_samples path a real,
 * exercisable read rather than a branch waiting for a registry entry.
 */
export function getStreamReadings(
  profileId: number,
  src: StreamReadingSource
): Reading[] {
  if (src.store === "body_metrics") {
    const rows = bodyMetricReadingSelect(src.key as BodyMetricColumn).all(
      profileId
    ) as {
      id: number;
      date: string;
      value: number;
      source: string | null;
      edited: number;
      notes: string | null;
    }[];
    return rows.map((r) => readingFromBodyMetric(r, src));
  }
  const rows = db
    .prepare(
      `SELECT id, date, value, source, start_time, edited FROM metric_samples
        WHERE profile_id = ? AND metric = ?
        ORDER BY date ASC, start_time ASC, id ASC`
    )
    .all(profileId, src.key) as {
    id: number;
    date: string;
    value: number;
    source: string | null;
    start_time: string | null;
    edited: number;
  }[];
  return rows.map((r) => readingFromMetricSample(r, src));
}

/**
 * Every OBSERVATION reading of an identity — the `medical_records` half, with its
 * document / encounter / provider provenance preserved.
 */
export function getObservationReadings(
  profileId: number,
  identity: string
): Reading[] {
  return getBiomarkerSeries(profileId, identity)
    .map((row) => readingFromObservation(row))
    .filter((r): r is Reading => r != null);
}

/**
 * The same-identity OBSERVATIONS a metric detail surface must fold in (#1996), or
 * `[]` when it must not — see `metricObservationFoldIdentity` for which is which.
 *
 * The metric keeps its own store's rows as its series; this is the completeness
 * half: a clinic-measured reading of the same quantity, which the stream never saw.
 */
export function getMetricObservations(
  profileId: number,
  slug: BodyMetricSlug
): Reading[] {
  const identity = metricObservationFoldIdentity(slug);
  return identity ? getObservationReadings(profileId, identity) : [];
}

/**
 * THE reading series for one quantity: observations and streams together, keyed by
 * identity, deduped, oldest first.
 *
 * A clinic-measured resting HR and a wearable one are the same identity, so they
 * come back in one series — distinguishable by `source` and by whether they carry
 * `provenance`, never by which table the caller had to know to ask.
 *
 * `readTx` because the halves must describe ONE snapshot: a sync landing between
 * two reads would otherwise produce a series that never existed.
 */
export function getReadingSeries(
  profileId: number,
  identity: string
): Reading[] {
  const streams = streamSourcesForIdentity(identity);
  if (streams.length === 0) {
    return sortReadings(getObservationReadings(profileId, identity));
  }
  return readTx(() => {
    const readings = [
      ...getObservationReadings(profileId, identity),
      ...streams.flatMap((src) => getStreamReadings(profileId, src)),
    ];
    return sortReadings(dedupeReadings(readings));
  });
}
