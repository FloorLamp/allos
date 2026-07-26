import { zonedDateParts } from "@/lib/date";
import { boundedOrNull, inTimeWindow } from "@/lib/ingest-bounds";
import type {
  NormActivity,
  NormBodyMetric,
  NormMetricSample,
  NormVital,
} from "./normalize";

// Parser for a Fitbit account export delivered through Google Takeout
// (`Takeout/Google Health/…`). PURE — no zip handling, no fs, no DB: every function
// here takes a path or a file's TEXT and returns normalized records, so the whole
// vocabulary is unit-testable without a 250 MB archive. The archive walk and the
// chunked write live in the impure sibling.
//
// The archive is NOT a tidy export. Three properties shape everything below, all
// measured on a real one (1092 files, ~1.4 GB uncompressed):
//
//   1. ~81% of the bytes are not health data — `UserActivityProbabilities` (~987 MB
//      of raw ML classifier output) and `UserSensorCompressionToken` (~150 MB of
//      internal sensor encoding). They must never be read, which is the difference
//      between a usable and an unusable memory profile.
//   2. Absent data is present as FILES. Glucose ships as 230 files each containing
//      the literal text `no data`; menstrual health, stress score and several
//      others are header-only. A parser that trusts file existence reports data
//      the user does not have.
//   3. The same measurement appears TWICE, in two directories with different
//      encodings — see SOURCE PRECEDENCE below.

export const FITBIT_TAKEOUT_ID = "fitbit-takeout";

// The archive root every supported entry sits under. Anything outside it (a Takeout
// bundle can carry unrelated Google products) is not ours.
export const TAKEOUT_HEALTH_ROOT = "Takeout/Google Health/";

// ---- SOURCE PRECEDENCE: prefer the CSVs, ignore the JSON twins ----
//
// `Global Export Data/` (JSON) and `Physical Activity_GoogleData/` (CSV) carry
// overlapping copies of heart rate, steps, distance and calories. Ingesting both
// double-counts, so exactly one wins — and it is the CSV, for two reasons that are
// not stylistic:
//
//   • TIMEZONE. The CSVs stamp `2026-06-10T16:39:00Z` — absolute, unambiguous. The
//     JSON stamps `06/10/26 16:39:00` — US-ordered LOCAL wall time with no offset,
//     so it can only be resolved against an assumed zone, and is silently wrong for
//     any day the user spent in another one.
//   • PROVENANCE. Only the CSVs carry a `data source` column, which is what makes
//     the Health-Connect round-trip below detectable at all.
//
// The JSON twins are therefore SKIPPED, not parsed-and-deduped: cheaper, and it
// keeps one encoding to reason about. Families that exist ONLY as JSON (sleep,
// exercise) are still read from there — see JSON_ONLY_FAMILIES.
const CSV_PREFERRED_FAMILIES = new Set([
  "steps",
  "distance",
  "calories",
  "heart_rate",
  "resting_heart_rate",
  "time_in_heart_rate_zones",
]);

// Directory segments whose contents are never health data. Matched as a path
// substring so a future dated variant (`UserActivityProbabilities_2026-07.csv`)
// stays excluded without a code change.
export const NEVER_READ = [
  "UserActivityProbabilities",
  "UserSensorCompressionToken",
];

// Fitbit's marker for "this data type exists in your account but holds nothing".
// An exact match on the trimmed body — a real CSV always has a header line.
export const NO_DATA_SENTINEL = "no data";

// ---- Health Connect round-trip ----
//
// A Takeout re-exports rows Fitbit itself INGESTED from Health Connect: the phone,
// Garmin, Strava and gym equipment all write into Health Connect, which syncs into
// Fitbit, which lands here. On a real archive that is ~11.4 k rows tagged
// `Phone Health Connect`, `Garmin Connect Health Connect`, `Strava Health Connect`,
// `Unknown Health Connect`, `Life Fitness Health Connect`.
//
// Allos ALREADY has those rows, from the push ingest, under `health-connect`. Taking
// them again under this provider would store the same measurement twice under two
// sources — surviving the #14 one-source-per-day pickers on the CHARTS but still
// wrong in the record, and actively confusing in the source-comparison overlay.
//
// So a row whose `data source` names Health Connect is DROPPED (counted, never
// silently vanished). The match is a suffix test rather than an explicit list: the
// vendor prefix is open-ended (any app that writes to Health Connect can appear),
// but the " Health Connect" tail is the stable part.
export const HEALTH_CONNECT_SOURCE_SUFFIX = "health connect";

export function isHealthConnectRoundTrip(dataSource: string | null): boolean {
  if (!dataSource) return false;
  return dataSource.trim().toLowerCase().endsWith(HEALTH_CONNECT_SOURCE_SUFFIX);
}

// ---- entry classification ----

// The families this parser knows how to read. A family is resolved from the entry
// path ONCE, so the walker can decide whether to read a file's bytes at all — the
// point of the exercise for a 250 MB archive.
export type TakeoutFamily =
  | "weight"
  | "body_fat"
  | "height"
  | "daily_resting_heart_rate"
  | "daily_respiratory_rate"
  | "daily_oxygen_saturation"
  | "computed_temperature"
  | "sleep_score"
  | "daily_readiness"
  | "sleep"
  | "exercise";

// Families that live ONLY as JSON under `Global Export Data/` — the CSV preference
// above cannot apply because there is no CSV twin.
const JSON_ONLY_FAMILIES: ReadonlySet<TakeoutFamily> = new Set([
  "sleep",
  "exercise",
]);

// Path → family. Returns null for an entry this parser does not consume, which is
// the overwhelming majority: the walker skips those without reading them.
//
// Matching is on the FILE NAME plus its immediate directory, because Takeout
// disambiguates by directory (`Temperature/Computed Temperature - <date>.csv`) and
// dates the file names (`daily_readiness.csv` has no date, `Minute SpO2 - <date>.csv`
// does). Deliberately conservative: an unrecognized name is skipped, never guessed.
export function classifyTakeoutEntry(path: string): TakeoutFamily | null {
  if (!path.startsWith(TAKEOUT_HEALTH_ROOT)) return null;
  if (NEVER_READ.some((seg) => path.includes(seg))) return null;
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  const dir = parts[parts.length - 2] ?? "";
  if (!file || file.toLowerCase().endsWith("readme.txt")) return null;

  // The JSON twins of a CSV-preferred family are skipped outright (see above).
  if (dir === "Global Export Data") {
    if (file.startsWith("sleep-") && file.endsWith(".json")) return "sleep";
    if (file.startsWith("exercise-") && file.endsWith(".json"))
      return "exercise";
    return null;
  }

  if (dir === "Physical Activity_GoogleData") {
    const stem = file.replace(/[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/, "");
    const base = stem.replace(/\.csv$/, "").replace(/[-_]$/, "");
    if (CSV_PREFERRED_FAMILIES.has(base)) return null; // intraday, not this pass
    if (base === "weight") return "weight";
    if (base === "body_fat") return "body_fat";
    if (base === "height") return "height";
    if (base === "daily_resting_heart_rate") return "daily_resting_heart_rate";
    if (base === "daily_respiratory_rate") return "daily_respiratory_rate";
    if (base === "daily_oxygen_saturation") return "daily_oxygen_saturation";
    if (base === "daily_readiness") return "daily_readiness";
    return null;
  }

  if (dir === "Temperature" && file.startsWith("Computed Temperature"))
    return "computed_temperature";
  if (dir === "Sleep Score" && file.startsWith("sleep_score"))
    return "sleep_score";

  return null;
}

// True when a family's entry is JSON (the walker decodes it differently).
export function isJsonFamily(fam: TakeoutFamily): boolean {
  return JSON_ONLY_FAMILIES.has(fam);
}

// ---- CSV primitives ----

// Split a CSV body into header + rows, tolerating CRLF and a trailing newline.
// Returns null for the `no data` sentinel and for a header-only file — both mean
// "this type is present in the account but empty", which is not an error and not a
// record. Quoted fields are NOT supported: every family above is plain numeric/ISO
// data with no embedded commas, and a hand-rolled quote parser would be more risk
// than value. A row whose field count doesn't match the header is dropped.
export function parseTakeoutCsv(
  text: string
): { header: string[]; rows: Record<string, string>[] } | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === NO_DATA_SENTINEL) return null;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length !== header.length) continue;
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i].trim()));
    rows.push(row);
  }
  return { header, rows };
}

// A finite number from a CSV cell, or null. An empty cell, a blank, and Fitbit's
// `NaN` (it writes literal NaN into the baseline columns before a baseline exists)
// all yield null rather than a bogus 0.
export function csvNum(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "nan") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// The calendar date a Takeout row belongs to. Not one format — a real archive uses
// THREE across the families here, and treating them alike shifts days:
//
//   `2026-07-26T06:11:30Z`  absolute instant  → convert through the profile zone
//   `2026-06-16`            bare calendar day → already the answer, use verbatim
//   `2026-06-11T00:00:00`   naive wall time   → take the date part verbatim
//
// The last two must NOT go through `new Date()`. ECMAScript parses a DATE-ONLY form
// as UTC midnight, so `2026-06-16` converted into a western zone yields 06-15 — a
// silent off-by-one on every readiness score. And it parses an offset-less DATE-TIME
// as PROCESS-local, which would make the result depend on the server's TZ (the exact
// non-determinism `zonedDateParts` exists to remove). For both, the date the file
// wrote IS the local date, so it is taken directly.
//
// Only the absolute form is range-checked (#132): a bare day carries no instant to
// bound, and rejecting it on a parse of assumed-midnight would re-introduce the zone
// assumption this function avoids.
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function localDate(iso: string | undefined, tz: string): string | null {
  if (!iso) return null;
  const t = iso.trim();
  if (!t) return null;
  if (BARE_DAY.test(t)) return t;
  if (!HAS_OFFSET.test(t)) {
    const day = t.slice(0, 10);
    return BARE_DAY.test(day) ? day : null;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime()) || !inTimeWindow(d.getTime())) return null;
  return zonedDateParts(tz, d).date;
}

// The `data source` column, when the family carries one. Absent for the families
// that don't (Computed Temperature, Sleep Score).
function dataSource(row: Record<string, string>): string | null {
  const v = row["data source"] ?? row["data_source"];
  return v && v.trim() ? v.trim() : null;
}

// ---- accumulating result ----

export interface TakeoutParsed {
  bodyMetrics: NormBodyMetric[];
  samples: NormMetricSample[];
  activities: NormActivity[];
  vitals: NormVital[];
  // Records dropped for any reason, so the Review feed's tally reflects them
  // instead of silently vanishing data (#419).
  skipped: number;
  // Rows dropped specifically because they round-tripped through Health Connect
  // and Allos already owns them under that provider. Counted SEPARATELY from
  // `skipped` so the sync event can say so — "we ignored N rows you already have"
  // is a very different message from "N rows were malformed".
  roundTripSkipped: number;
  warnings: string[];
}

export function emptyTakeoutParsed(): TakeoutParsed {
  return {
    bodyMetrics: [],
    samples: [],
    activities: [],
    vitals: [],
    skipped: 0,
    roundTripSkipped: 0,
    warnings: [],
  };
}

// ---- vendor daily scores (extends the #1069 pattern) ----
//
// Fitbit's own 0–100 Sleep Score and Daily Readiness. Same stance as Oura's
// (lib/integrations/oura.ts): STORE-WHAT-THE-SOURCE-SAID display values, rendered
// ATTRIBUTED ("Fitbit sleep score", never a bare "sleep score"), feeding NO engine.
// The kinds are VENDOR-PREFIXED exactly as #1069 anticipated ("a future fitbit_/
// garmin_ score can't collide"), and their inertness is pinned by the same
// reverse-allowlist guard.
export const FITBIT_SLEEP_SCORE_METRIC = "fitbit_sleep_score";
export const FITBIT_READINESS_SCORE_METRIC = "fitbit_readiness_score";

// ---- per-family parsers ----

// Weight / body fat → body_metrics, one row per local day.
//
// These are the ONLY families in the archive with real depth (a third-party smart
// scale has been writing through Fitbit's Web API for years, and Fitbit never
// forwards weight to Health Connect — so this is data no other ingest path can
// reach). Weight arrives in GRAMS; body fat as a percentage.
export function parseWeightCsv(text: string, tz: string): TakeoutParsed {
  return parseBodyCompositionCsv(text, tz, "weight");
}

export function parseBodyFatCsv(text: string, tz: string): TakeoutParsed {
  return parseBodyCompositionCsv(text, tz, "body_fat");
}

function parseBodyCompositionCsv(
  text: string,
  tz: string,
  kind: "weight" | "body_fat"
): TakeoutParsed {
  const out = emptyTakeoutParsed();
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return out;
  // Last reading of a day wins, matching the Health Connect parser's weight rule.
  const byDate = new Map<string, number>();
  for (const row of parsed.rows) {
    if (isHealthConnectRoundTrip(dataSource(row))) {
      out.roundTripSkipped++;
      continue;
    }
    const date = localDate(row.timestamp, tz);
    const raw =
      kind === "weight"
        ? csvNum(row["weight grams"])
        : csvNum(row["fat percentage"] ?? row["body fat percentage"]);
    if (!date || raw == null) {
      out.skipped++;
      continue;
    }
    const value = boundedOrNull(
      kind === "weight" ? "weight_kg" : "body_fat_pct",
      kind === "weight" ? raw / 1000 : raw
    );
    if (value == null) {
      out.skipped++;
      continue;
    }
    byDate.set(date, value);
  }
  out.bodyMetrics = [...byDate.entries()].map(([date, v]) => ({
    date,
    ...(kind === "weight" ? { weight_kg: v } : { body_fat_pct: v }),
  }));
  return out;
}

// Daily resting heart rate → body_metrics. Fitbit reports a fractional bpm
// (`66.876`); body_metrics.resting_hr is a whole number, matching the HC parser.
export function parseDailyRestingHrCsv(
  text: string,
  tz: string
): TakeoutParsed {
  const out = emptyTakeoutParsed();
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return out;
  const byDate = new Map<string, number>();
  for (const row of parsed.rows) {
    if (isHealthConnectRoundTrip(dataSource(row))) {
      out.roundTripSkipped++;
      continue;
    }
    const date = localDate(row.timestamp, tz);
    const bpm = boundedOrNull("resting_hr", csvNum(row["beats per minute"]));
    if (!date || bpm == null) {
      out.skipped++;
      continue;
    }
    byDate.set(date, Math.round(bpm));
  }
  out.bodyMetrics = [...byDate.entries()].map(([date, resting_hr]) => ({
    date,
    resting_hr,
  }));
  return out;
}

// Daily respiratory rate and daily SpO2 → medical_records vitals, matching the
// canonical names/units the Health Connect parser writes so a Takeout reading and a
// synced one share one series and one reference-range flag.
//
// SpO2 uses the DAILY file, never `Minute SpO2`: the minute stream from a wrist
// sensor carries physiologically impossible excursions (a real archive holds a 50.0
// two minutes after a 94.3), and the daily row is the vendor's own aggregate with
// explicit lower/upper bounds. `estimated_oxygen_variation` is NOT SpO2 at all —
// despite the name it is an "Infrared to Red Signal Ratio", a raw sensor quantity
// on no saturation scale, and mapping it to Oxygen Saturation would be a fabricated
// reading.
export function parseDailyVitalCsv(
  text: string,
  tz: string,
  kind: "respiratory_rate" | "oxygen_saturation"
): TakeoutParsed {
  const out = emptyTakeoutParsed();
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return out;
  const spec =
    kind === "respiratory_rate"
      ? {
          column: "breaths per minute",
          canonical: "Respiratory Rate",
          unit: "breaths/min",
        }
      : {
          column: "average percentage",
          canonical: "Oxygen Saturation",
          unit: "%",
        };
  for (const row of parsed.rows) {
    if (isHealthConnectRoundTrip(dataSource(row))) {
      out.roundTripSkipped++;
      continue;
    }
    const iso = row.timestamp;
    const date = localDate(iso, tz);
    const value = boundedOrNull(spec.canonical, csvNum(row[spec.column]));
    if (!date || !iso || value == null) {
      out.skipped++;
      continue;
    }
    out.vitals.push({
      external_id: `${FITBIT_TAKEOUT_ID}:${spec.canonical}:${iso}`,
      date,
      category: "vitals",
      name: spec.canonical,
      canonical: spec.canonical,
      value_num: Math.round(value * 10) / 10,
      unit: spec.unit,
    });
  }
  return out;
}

// Fitbit's 0–100 daily scores → vendor-prefixed metric_samples. Sleep Score's
// component columns (`composition_score`, `duration_score`) are blank or `-1`
// sentinels throughout a real archive, so only the overall score is taken — which
// matches the Oura precedent's single-number shape rather than inventing a
// breakdown from partial data.
export function parseVendorScoreCsv(
  text: string,
  tz: string,
  kind: "sleep_score" | "daily_readiness"
): TakeoutParsed {
  const out = emptyTakeoutParsed();
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return out;
  const metric =
    kind === "sleep_score"
      ? FITBIT_SLEEP_SCORE_METRIC
      : FITBIT_READINESS_SCORE_METRIC;
  const column = kind === "sleep_score" ? "overall_score" : "score";
  // One row per day per kind; a re-import of the same archive dedups on the natural
  // key (metric, source, start_time), like every other sample.
  const byDate = new Map<string, number>();
  for (const row of parsed.rows) {
    const iso = row.timestamp;
    const date = localDate(iso, tz);
    const score = boundedOrNull(metric, csvNum(row[column]));
    if (!date || score == null) {
      out.skipped++;
      continue;
    }
    byDate.set(date, Math.round(score));
  }
  for (const [date, value] of byDate) {
    const instant = `${date}T00:00:00.000Z`;
    out.samples.push({
      metric,
      date,
      start_time: instant,
      end_time: instant,
      value,
    });
  }
  return out;
}
