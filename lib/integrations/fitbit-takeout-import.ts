import fs from "node:fs";
import { writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { chunk, INGEST_CHUNK_SIZE } from "@/lib/ingest-bounds";
import { getTimezone } from "@/lib/settings";
import {
  EOCD_MAX_SCAN,
  EOCD_MIN_BYTES,
  ZipIndexError,
  findEocd,
  inflateEntry,
  localDataOffset,
  parseCentralDirectory,
  parseEocd,
  type ZipIndexEntry,
} from "@/lib/zip-index";
import {
  emptyCounts,
  foldCounts,
  partialWriteFailureMessage,
  summarizeSplit,
  type ProvenanceEntry,
  type UpsertCounts,
} from "./sync-log";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertHrMinutes,
  upsertMetricSamples,
  upsertPracticeLogs,
  upsertVitals,
} from "./normalize";
import { recordSyncEvent, recordSyncRows } from "./connections";
import {
  FITBIT_TAKEOUT_ID,
  classifyTakeoutEntry,
  emptyTakeoutParsed,
  finalizeDailySums,
  finalizeHrBuckets,
  foldDailySums,
  foldHrBuckets,
  intradaySumMetric,
  isIntradaySumFamily,
  parseHeartRateCsv,
  parseIntradaySumCsv,
  type HrBucketAcc,
  type IntradaySumFamily,
  parseBodyFatCsv,
  parseDailyRestingHrCsv,
  parseDailyVitalCsv,
  parseExerciseJson,
  parseComputedTemperatureCsv,
  parseSleepJson,
  parseVendorScoreCsv,
  parseWeightCsv,
  type TakeoutFamily,
  type TakeoutParsed,
} from "./fitbit-takeout";

const log = createLogger("fitbit-takeout");

// The archive walk + chunked write for a Fitbit Google Takeout export. The impure
// half of the importer: fs, zip inflation and DB writes live here, while every
// format decision stays in the pure sibling.
//
// SELECTIVE BY DESIGN. The archive is ~250 MB compressed / ~1.4 GB uncompressed, and
// the useful part is ~2% of its entries. So this never inflates the archive: it
// reads the central directory, asks `classifyTakeoutEntry` about each NAME, and
// inflates only the survivors — one at a time, released between files. On a real
// export that is 21 entries read of 1092. Reading everything first (what
// `lib/zip.ts`'s readZip does, correctly, for a small XDM package) would allocate
// well over a gigabyte before parsing a single row.

export interface TakeoutImportResult {
  // Entries the classifier accepted and this run actually read.
  entriesRead: number;
  // Entries skipped without inflating a byte.
  entriesSkipped: number;
  counts: UpsertCounts;
  parsed: {
    bodyMetrics: number;
    hrMinutes: number;
    samples: number;
    activities: number;
    practices: number;
    vitals: number;
  };
  skipped: number;
  roundTripSkipped: number;
  warnings: string[];
}

// Marks a write-path failure whose partial, already-committed chunks have already
// been represented by a sync event. The route uses this to avoid appending a second
// generic failure event for the same upload; parse/upload failures do not use this
// class and are recorded at the request boundary instead.
export class FitbitTakeoutWriteError extends Error {
  readonly syncEventRecorded: boolean;

  constructor(cause: unknown, syncEventRecorded: boolean) {
    super("Fitbit Takeout import failed while writing records", { cause });
    this.name = "FitbitTakeoutWriteError";
    this.syncEventRecorded = syncEventRecorded;
  }
}

// Read the archive's index without inflating anything. Positional reads only: the
// EOCD scan touches at most 64 KB of the tail, and the central directory is read as
// one span, so peak memory is bounded by the directory's size rather than the
// archive's.
export function readZipIndex(fd: number, size: number): ZipIndexEntry[] {
  if (size < EOCD_MIN_BYTES)
    throw new ZipIndexError("Not a valid ZIP archive.");
  const tailLen = Math.min(size, EOCD_MAX_SCAN);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  const at = findEocd(tail);
  if (at < 0) throw new ZipIndexError("Not a valid ZIP archive.");
  const { entryCount, cdOffset, cdSize } = parseEocd(tail, at);
  const cd = Buffer.alloc(Math.min(cdSize, size));
  fs.readSync(fd, cd, 0, cd.length, cdOffset);
  return parseCentralDirectory(cd, entryCount);
}

// Inflate ONE indexed entry. Two positional reads — the 30-byte local header (whose
// name/extra lengths are authoritative for where the data starts), then the
// compressed span.
export function readIndexedEntry(fd: number, e: ZipIndexEntry): Buffer {
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, e.localOffset);
  const dataStart = localDataOffset(header, e.localOffset);
  const raw = Buffer.alloc(e.compSize);
  fs.readSync(fd, raw, 0, e.compSize, dataStart);
  return inflateEntry(raw, e.method);
}

// Route one entry's text to its family's parser. Kept exhaustive over TakeoutFamily
// so adding a family to the classifier without a parser is a compile error rather
// than silently-dropped data.
type SimpleFamily = Exclude<TakeoutFamily, "heart_rate" | IntradaySumFamily>;

function parseFamily(
  family: SimpleFamily,
  text: string,
  tz: string
): TakeoutParsed {
  switch (family) {
    case "weight":
      return parseWeightCsv(text, tz);
    case "body_fat":
      return parseBodyFatCsv(text, tz);
    case "daily_resting_heart_rate":
      return parseDailyRestingHrCsv(text, tz);
    case "daily_respiratory_rate":
      return parseDailyVitalCsv(text, tz, "respiratory_rate");
    case "daily_oxygen_saturation":
      return parseDailyVitalCsv(text, tz, "oxygen_saturation");
    case "sleep_score":
      return parseVendorScoreCsv(text, tz, "sleep_score");
    case "daily_readiness":
      return parseVendorScoreCsv(text, tz, "daily_readiness");
    case "sleep":
      return parseSleepJson(text, tz);
    case "exercise":
      return parseExerciseJson(text, tz);
    case "computed_temperature":
      return parseComputedTemperatureCsv(text, tz);
  }
}

function mergeInto(acc: TakeoutParsed, add: TakeoutParsed): void {
  acc.bodyMetrics.push(...add.bodyMetrics);
  acc.hrMinutes.push(...add.hrMinutes);
  acc.samples.push(...add.samples);
  acc.activities.push(...add.activities);
  acc.practices.push(...add.practices);
  acc.vitals.push(...add.vitals);
  acc.skipped += add.skipped;
  acc.roundTripSkipped += add.roundTripSkipped;
  for (const w of add.warnings)
    if (!acc.warnings.includes(w)) acc.warnings.push(w);
}

// Parse an archive at `path` into normalized records. Does NOT write.
export function parseTakeoutArchive(
  path: string,
  tz: string
): { parsed: TakeoutParsed; entriesRead: number; entriesSkipped: number } {
  const fd = fs.openSync(path, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const index = readZipIndex(fd, size);
    const acc = emptyTakeoutParsed();
    // The intraday families are FOLDED rather than concatenated: heart rate is
    // ~1.6 M rows that must never exist as 1.6 M objects, and a day (or a minute at
    // a day boundary) can appear in more than one file, so subtotals have to sum
    // instead of overwrite.
    const hrAcc = new Map<string, HrBucketAcc>();
    const sumAcc = new Map<IntradaySumFamily, Map<string, number>>();
    let read = 0;
    let skipped = 0;
    for (const entry of index) {
      const family = classifyTakeoutEntry(entry.name);
      if (!family) {
        skipped++;
        continue;
      }
      read++;
      try {
        // The buffer is scoped to this iteration and released before the next, so
        // peak memory is one entry, not the archive.
        const text = readIndexedEntry(fd, entry).toString("utf8");
        if (family === "heart_rate") {
          const r = parseHeartRateCsv(text, tz);
          foldHrBuckets(hrAcc, r.buckets);
          acc.skipped += r.skipped;
          acc.roundTripSkipped += r.roundTrip;
        } else if (isIntradaySumFamily(family)) {
          const r = parseIntradaySumCsv(text, tz, family);
          let m = sumAcc.get(family);
          if (!m) sumAcc.set(family, (m = new Map()));
          foldDailySums(m, r.perDay);
          acc.skipped += r.skipped;
          acc.roundTripSkipped += r.roundTrip;
        } else {
          mergeInto(acc, parseFamily(family, text, tz));
        }
      } catch (err) {
        // One unreadable member must not abort an otherwise good import — the
        // archive is large and user-supplied. Count it and carry on.
        acc.skipped++;
        acc.warnings.push(`could not read ${entry.name.split("/").pop()}`);
        log.error("takeout entry unreadable", { entry: entry.name, err });
      }
    }
    acc.hrMinutes.push(...finalizeHrBuckets(hrAcc));
    for (const [family, perDay] of sumAcc)
      acc.samples.push(...finalizeDailySums(perDay, intradaySumMetric(family)));
    return { parsed: acc, entriesRead: read, entriesSkipped: skipped };
  } finally {
    fs.closeSync(fd);
  }
}

// Parse + write, recording ONE sync event for the run so Data → Review shows it
// beside every other source's. Each record type is written in bounded slices, each
// slice its own IMMEDIATE transaction (#468), so the single better-sqlite3
// connection is never held for the length of a multi-thousand-row import.
export function importTakeoutArchive(
  profileId: number,
  path: string,
  chunkSize: number = INGEST_CHUNK_SIZE
): TakeoutImportResult {
  const tz = getTimezone(profileId);
  const { parsed, entriesRead, entriesSkipped } = parseTakeoutArchive(path, tz);

  let counts = emptyCounts();
  const provenance: ProvenanceEntry[] = [];
  // Keep provenance transactional with its chunk. Upserts append to the supplied
  // array while the transaction is open; if that transaction rolls back, its local
  // array is discarded rather than leaking nonexistent target ids into the partial
  // failure event. Only a successfully committed chunk contributes counts/rows.
  const commitSlices = <T>(
    rows: readonly T[],
    upsert: (slice: T[], sink: ProvenanceEntry[]) => UpsertCounts
  ) => {
    for (const slice of chunk(rows, chunkSize)) {
      const chunkProvenance: ProvenanceEntry[] = [];
      const part = writeTx(() => upsert(slice, chunkProvenance));
      counts = foldCounts([counts, part]);
      provenance.push(...chunkProvenance);
    }
  };

  try {
    commitSlices(parsed.bodyMetrics, (slice, sink) =>
      upsertBodyMetrics(profileId, slice, FITBIT_TAKEOUT_ID, sink)
    );
    commitSlices(parsed.hrMinutes, (slice) =>
      upsertHrMinutes(profileId, slice, FITBIT_TAKEOUT_ID)
    );
    commitSlices(parsed.samples, (slice, sink) =>
      upsertMetricSamples(profileId, slice, FITBIT_TAKEOUT_ID, sink)
    );
    commitSlices(parsed.activities, (slice, sink) =>
      upsertActivities(profileId, slice, FITBIT_TAKEOUT_ID, sink)
    );
    commitSlices(parsed.practices, (slice, sink) =>
      upsertPracticeLogs(profileId, slice, FITBIT_TAKEOUT_ID, sink)
    );
    commitSlices(
      parsed.vitals,
      (slice, sink) =>
        upsertVitals(profileId, slice, FITBIT_TAKEOUT_ID, sink).counts
    );
  } catch (err) {
    // Earlier chunks are durable by design, so represent exactly what completed.
    // `received` is the accounted portion of this failed run (the split invariant),
    // not a claim that every normalized archive row reached the write path.
    const tally = summarizeSplit(counts, parsed.skipped);
    const failure = partialWriteFailureMessage(
      "Takeout import",
      tally.inserted + tally.updated,
      "re-importing the archive is safe."
    );
    const eventId = recordSyncEvent(profileId, FITBIT_TAKEOUT_ID, {
      ok: false,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      suppressed: tally.suppressed,
      edited: tally.edited,
      skipped: tally.skipped,
      details: JSON.stringify({ warnings: [failure], origins: [] }),
      error: failure,
    });
    recordSyncRows(eventId, provenance);
    throw new FitbitTakeoutWriteError(err, eventId !== null);
  }

  const warnings = [...parsed.warnings];
  // The round-trip drop is reported EXPLICITLY rather than folded into `skipped`:
  // "we ignored rows you already have from Health Connect" is a reassurance, while
  // a skip count reads as data loss.
  if (parsed.roundTripSkipped > 0)
    warnings.push(
      `${parsed.roundTripSkipped} rows already synced through Health Connect were left to that source.`
    );

  const tally = summarizeSplit(counts, parsed.skipped);
  const eventId = recordSyncEvent(profileId, FITBIT_TAKEOUT_ID, {
    ok: true,
    received: tally.received,
    written: tally.inserted + tally.updated + tally.unchanged,
    inserted: tally.inserted,
    updated: tally.updated,
    unchanged: tally.unchanged,
    suppressed: tally.suppressed,
    edited: tally.edited,
    skipped: tally.skipped,
    // Serialized here, not by recordSyncEvent — `details` is a JSON STRING column and
    // the shape is the one Data → Review already renders for Health Connect, so the
    // warnings surface with no reader change.
    details: JSON.stringify({ warnings, origins: [] }),
  });
  recordSyncRows(eventId, provenance);

  return {
    entriesRead,
    entriesSkipped,
    counts,
    parsed: {
      bodyMetrics: parsed.bodyMetrics.length,
      hrMinutes: parsed.hrMinutes.length,
      samples: parsed.samples.length,
      activities: parsed.activities.length,
      practices: parsed.practices.length,
      vitals: parsed.vitals.length,
    },
    skipped: parsed.skipped,
    roundTripSkipped: parsed.roundTripSkipped,
    warnings,
  };
}
