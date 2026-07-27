import { zonedDateParts, zonedMinuteStr } from "@/lib/date";
import { boundedOrNull, inTimeWindow } from "@/lib/ingest-bounds";
import type {
  NormActivity,
  NormBodyMetric,
  NormHrMinute,
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
//   • EXPLICITNESS. The CSVs stamp `2026-06-10T16:39:00Z` — absolute and marked. The
//     JSON stamps `06/10/26 16:39:00`, which is the SAME instant in UTC but carries
//     no marker saying so, and reads naturally (and wrongly) as local wall time. See
//     parseUsUtcStamp for how that misreading was caught.
//   • PROVENANCE. Only the CSVs carry a `data source` column, which is what makes
//     the Health-Connect round-trip below detectable at all.
//
// The JSON twins are therefore SKIPPED, not parsed-and-deduped: cheaper, and it
// keeps one encoding to reason about. Families that exist ONLY as JSON (sleep,
// exercise) are still read from there — see JSON_ONLY_FAMILIES.
// ---- what the INTRADAY streams may and may not be summed into ----
//
// The minute-level CSVs omit rows rather than writing zeros, so whether a daily
// total can be derived from them depends entirely on whether an omitted minute
// MEANS zero. Measured against the JSON twin, which does carry all 1440 minutes:
//
//   steps     CSV 7,005 over 220 rows   JSON 7,005 over 753   → identical
//   distance  CSV 4,677.7 m over 220    JSON 467,770 cm/753   → identical (×100)
//   calories  CSV 1,268 over 956 rows   JSON 2,811 over 1440  → NOT identical
//
// Steps and distance agree exactly: a minute with no row is a minute with no
// movement, so the sparse stream sums to the true total. Total calories do NOT,
// and cannot — basal burn never stops, so the 484 missing minutes are real energy.
// Summing that CSV would store ~45% of a day's calories as if it were the whole
// day, the same failure as the 15-minute Health Connect gap (#1065) but silent.
//
// So `calories` is deliberately NOT ingested. Health Connect already delivers an
// authoritative daily total, and a competing under-counted one is worse than none.
// `active_energy_burned` IS taken: active energy is zero by definition when
// sedentary, so its omitted minutes really are zeros (its row count matches the
// JSON's non-zero-minute count exactly).
const INTRADAY_NOT_SUMMABLE = new Set(["calories"]);

// Families with no model home at all, listed so the reason is recorded rather than
// rediscovered: heart-rate zone minutes and Fitbit's SEDENTARY/LIGHTLY/… activity
// bands are vendor classifications with no metric to land in.
const NO_HOME_FAMILIES = new Set([
  "time_in_heart_rate_zones",
  "activity_level",
  "resting_heart_rate",
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
  | "exercise"
  | "heart_rate"
  | "intraday_steps"
  | "intraday_distance"
  | "active_energy";

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
    if (INTRADAY_NOT_SUMMABLE.has(base) || NO_HOME_FAMILIES.has(base))
      return null;
    if (base === "heart_rate") return "heart_rate";
    if (base === "steps") return "intraday_steps";
    if (base === "distance") return "intraday_distance";
    if (base === "active_energy_burned") return "active_energy";
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

// The day a DAILY-AGGREGATE row is FOR, taken verbatim from its timestamp.
//
// Fitbit stamps its per-day and per-night aggregates at midnight UTC —
// `2026-06-11T00:00:00Z` on daily_respiratory_rate — and that is a LABEL for the
// day, not the instant anything was measured. Running it through the profile zone
// walks it backwards: in New York that midnight is 20:00 the previous evening, so
// every reading lands a day early. Caught by comparing against the same readings
// arriving over Health Connect, which timestamps a real instant (the end of the
// sleep session) and therefore dates them correctly — the two series were identical
// but offset by exactly one day.
//
// So an aggregate's date is its date string, full stop. Only genuinely INSTANTANEOUS
// families (a weigh-in, an intraday sample) go through localDate/localMinute, where
// the zone conversion is the whole point.
export function dayLabelDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const day = iso.trim().slice(0, 10);
  return BARE_DAY.test(day) ? day : null;
}

// The profile-local MINUTE key an instant buckets into — the hr_minutes natural key,
// identical in shape to what the Health Connect parser writes, so a Takeout minute
// and a synced minute for the same time collide on the key instead of duplicating.
//
// Unlike localDate this accepts ONLY an absolute instant: every intraday CSV stamps
// one, and a minute bucket derived from an offset-less wall time would silently
// depend on the server's timezone.
export function localMinute(iso: string, tz: string): string | null {
  if (!HAS_OFFSET.test(iso.trim())) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !inTimeWindow(d.getTime())) return null;
  return zonedMinuteStr(tz, d);
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
  hrMinutes: NormHrMinute[];
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
    hrMinutes: [],
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
    const date = dayLabelDate(row.timestamp);
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
    const date = dayLabelDate(iso);
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

// ---- intraday: heart rate ----
//
// The archive's largest stream by far: ~1.6 M rows across 47 files, sampled every
// few SECONDS. It is bucketed to the minute HERE, inside the per-file parse, rather
// than accumulated and bucketed later — the whole point is that no caller ever holds
// 1.6 M objects. One file (a day) yields at most 1440 buckets.
//
// Buckets are returned as raw accumulators (sum/n/min/max) rather than finished
// averages so the walker can FOLD two files that both touch a minute — which happens
// at a day boundary — without averaging an average.

export interface HrBucketAcc {
  ts: string; // profile-local minute key, the hr_minutes natural key
  sum: number;
  n: number;
  min: number;
  max: number;
}

export function parseHeartRateCsv(
  text: string,
  tz: string
): { buckets: HrBucketAcc[]; skipped: number; roundTrip: number } {
  const out = new Map<string, HrBucketAcc>();
  let skipped = 0;
  let roundTrip = 0;
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return { buckets: [], skipped, roundTrip };
  for (const row of parsed.rows) {
    if (isHealthConnectRoundTrip(dataSource(row))) {
      roundTrip++;
      continue;
    }
    const iso = row.timestamp;
    const bpm = boundedOrNull(
      "heart_rate_bpm",
      csvNum(row["beats per minute"])
    );
    const ts = iso ? localMinute(iso, tz) : null;
    if (!ts || bpm == null) {
      skipped++;
      continue;
    }
    const b = out.get(ts);
    if (!b) out.set(ts, { ts, sum: bpm, n: 1, min: bpm, max: bpm });
    else {
      b.sum += bpm;
      b.n++;
      if (bpm < b.min) b.min = bpm;
      if (bpm > b.max) b.max = bpm;
    }
  }
  return { buckets: [...out.values()], skipped, roundTrip };
}

// Fold a file's buckets into a running accumulator. Separate from the parse so a
// minute split across two files sums rather than overwrites.
export function foldHrBuckets(
  acc: Map<string, HrBucketAcc>,
  add: HrBucketAcc[]
): void {
  for (const b of add) {
    const cur = acc.get(b.ts);
    if (!cur) acc.set(b.ts, { ...b });
    else {
      cur.sum += b.sum;
      cur.n += b.n;
      if (b.min < cur.min) cur.min = b.min;
      if (b.max > cur.max) cur.max = b.max;
    }
  }
}

export function finalizeHrBuckets(
  acc: Map<string, HrBucketAcc>
): NormHrMinute[] {
  return [...acc.values()].map((b) => ({
    ts: b.ts,
    bpm: b.sum / b.n,
    bpm_min: b.min,
    bpm_max: b.max,
    n: b.n,
  }));
}

// ---- intraday: the summable daily streams ----
//
// steps / distance / active energy, summed per profile-local day. Safe ONLY because
// an omitted minute in these three genuinely means zero — see INTRADAY_NOT_SUMMABLE
// above for the measurement that establishes it, and for why total calories are not
// here.
export type IntradaySumFamily =
  "intraday_steps" | "intraday_distance" | "active_energy";

const INTRADAY_SPEC: Record<
  IntradaySumFamily,
  { metric: string; column: string; scale: number }
> = {
  // The CSV's `distance` column is METRES (cross-checked against the JSON twin's
  // centimetres: 467,770 cm == 4,677.7 m for one day), and the canonical unit is km.
  intraday_distance: {
    metric: "distance_km",
    column: "distance",
    scale: 0.001,
  },
  intraday_steps: { metric: "steps", column: "steps", scale: 1 },
  active_energy: { metric: "active_kcal", column: "Kilocalories", scale: 1 },
};

// The metric an intraday-sum family lands in. Exported so the walker can finalize
// its accumulator without re-deriving the mapping.
export function intradaySumMetric(family: IntradaySumFamily): string {
  return INTRADAY_SPEC[family].metric;
}

export function isIntradaySumFamily(
  family: TakeoutFamily
): family is IntradaySumFamily {
  return (
    family === "intraday_steps" ||
    family === "intraday_distance" ||
    family === "active_energy"
  );
}

export function parseIntradaySumCsv(
  text: string,
  tz: string,
  family: IntradaySumFamily
): { perDay: Map<string, number>; skipped: number; roundTrip: number } {
  const spec = INTRADAY_SPEC[family];
  const perDay = new Map<string, number>();
  let skipped = 0;
  let roundTrip = 0;
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return { perDay, skipped, roundTrip };
  for (const row of parsed.rows) {
    // Dropping these is what keeps the sum honest twice over: they are already held
    // under the health-connect provider, AND the phone counts the same steps the
    // watch does, so summing both would inflate the day (~9 k phone rows against
    // ~11.5 k watch rows on a real archive).
    if (isHealthConnectRoundTrip(dataSource(row))) {
      roundTrip++;
      continue;
    }
    const date = localDate(row.timestamp, tz);
    const raw = csvNum(row[spec.column]);
    if (!date || raw == null) {
      skipped++;
      continue;
    }
    perDay.set(date, (perDay.get(date) ?? 0) + raw * spec.scale);
  }
  return { perDay, skipped, roundTrip };
}

// Fold one file's per-day subtotals into a running accumulator, then finalize to
// samples. Folding is required, not cosmetic: a family can span several files and a
// day can appear in more than one of them.
export function foldDailySums(
  acc: Map<string, number>,
  add: Map<string, number>
): void {
  for (const [date, v] of add) acc.set(date, (acc.get(date) ?? 0) + v);
}

// A day's total becomes ONE sample spanning that local day. The natural key
// (metric, source, start_time) is therefore one row per metric per day, so a
// re-import of the same archive updates in place rather than accumulating.
export function finalizeDailySums(
  acc: Map<string, number>,
  metric: string
): NormMetricSample[] {
  const out: NormMetricSample[] = [];
  for (const [date, total] of acc) {
    const value = boundedOrNull(metric, total);
    if (value == null) continue;
    out.push({
      metric,
      date,
      start_time: `${date}T00:00:00.000Z`,
      end_time: `${date}T23:59:59.999Z`,
      value,
    });
  }
  return out;
}

// ---- computed (nightly) temperature ----
//
// Fitbit's own per-night skin-temperature record, and the better half of the two
// paths this app has to that signal. Health Connect can only ever carry the last
// night or two — its exporter pushes a rolling 48-hour window — while the archive
// holds every night the device has seen (46 against 1, measured on a real pair).
//
// It also states the SLEEP WINDOW outright (`sleep_start`/`sleep_end`), which
// retires a piece of inference: the Health Connect path gets a bare instant stamped
// at sleep onset and has to decide which night that belongs to by testing whether it
// falls inside a session. Here the night is given.
//
// The stored value is the same `skin_temp_delta_c` the Health Connect path writes —
// a deviation from the tracker's own rolling baseline — so both land in one series
// and one chart rather than splitting the signal across two metrics.
//
// THAT VALUE IS DERIVED, which is a step beyond this parser's usual store-what-the-
// source-said and is worth being explicit about. The row carries the baseline-
// relative deviations SUMMED over the night plus the sample count, so the mean
// deviation is `sum / samples` — arithmetic on Fitbit's own baseline-relative
// figures, not a baseline this app invents. It lands close to, but not identical
// to, what Health Connect pushes for the same night (measured: −0.066 against −0.1,
// +0.470 against +0.6), because the two describe slightly different windows and so
// average different sample sets.
//
// ON THE FEW NIGHTS BOTH SOURCES COVER, the reader AVERAGES them rather than picking
// one: skin_temp_delta_c is an AVERAGED_METRICS kind, and getMetricDailyTotals takes
// the mean across sources for those unless the profile has pinned a primary source.
// (PROVIDER_PREFERENCE's one-source-per-day pick governs ADDITIVE metrics, where
// summing two sources would double-count — a distinction easy to get backwards.)
// That is the intended semantics for a point metric: two sources measuring the same
// quantity should agree, and here they nearly do. It does mean the chart can show a
// value neither source reported (0.6 and 0.47 render as 0.53), so a profile wanting
// one of them verbatim pins it with the primary-source picker.
//
// `nightly_temperature` — the ABSOLUTE °C, ~32.9–34.1 on a real archive — is
// deliberately NOT stored. Wrist temperature is dominated by room temperature and
// bedding, so without a personal baseline it is not interpretable; that is exactly
// why both Fitbit and Health Connect surface the delta instead. Storing it would add
// a chart with no readable meaning.
export function parseComputedTemperatureCsv(
  text: string,
  tz: string
): TakeoutParsed {
  const out = emptyTakeoutParsed();
  const parsed = parseTakeoutCsv(text);
  if (!parsed) return out;
  // Last night wins per wake-day: a same-day nap and a night would otherwise both
  // claim the day, and the overnight record is the one this signal is about.
  const byDate = new Map<string, number>();
  for (const row of parsed.rows) {
    // The wake day — the local date the session ENDS — matching how sleep totals and
    // stages are attributed everywhere else, so a night's temperature sits with that
    // night's sleep rather than a day off.
    const date = localDate(row.sleep_end, tz);
    const sum = csvNum(row.baseline_relative_sample_sum);
    const samples = csvNum(row.temperature_samples);
    // Fitbit writes a literal NaN into the baseline columns for the first nights of
    // a device's life, before it has a baseline to be relative to. csvNum already
    // reads that as absent; the guard here is that absent must mean SKIP, never a
    // zero deviation (which would read as a perfectly average night).
    if (!date || sum == null || samples == null || samples <= 0) {
      out.skipped++;
      continue;
    }
    const delta = boundedOrNull("skin_temp_delta_c", sum / samples);
    if (delta == null) {
      out.skipped++;
      continue;
    }
    byDate.set(date, delta);
  }
  for (const [date, value] of byDate) {
    const instant = `${date}T00:00:00.000Z`;
    out.samples.push({
      metric: "skin_temp_delta_c",
      date,
      start_time: instant,
      end_time: instant,
      value,
    });
  }
  return out;
}

// ---- sleep ----
//
// One Fitbit sleep log → a nightly `sleep_min` total plus the four-bucket stage
// breakdown, matching what the Health Connect and Oura parsers write so a Takeout
// night and a synced night share one series.
//
// The wake day comes from `dateOfSleep`, which Fitbit already states as a BARE
// calendar day — the same attribution every other sleep source uses (the local date
// the session ENDS), stated rather than derived, so no zone conversion is involved.
//
// Stage minutes come from `levels.summary`, the vendor's own per-stage aggregate in
// WHOLE minutes — one row per stage per night, exactly the shape Oura and Withings
// deliver. The per-stage `levels.data` array is deliberately NOT summed instead: it
// would produce dozens of rows per night for no extra fidelity (the summary is
// already whole minutes) and re-open the per-stage rounding problem that #1562 had
// to fix on the Health Connect path.
//
// `type: "classic"` logs (an older tracker with no stage detection) carry only
// asleep/restless/awake and no stage summary; their total is still taken.
const FITBIT_STAGE_METRIC: Record<string, string> = {
  deep: "sleep_deep_min",
  rem: "sleep_rem_min",
  light: "sleep_light_min",
  wake: "sleep_awake_min",
};

export function parseSleepJson(text: string): TakeoutParsed {
  const out = emptyTakeoutParsed();
  let logs: unknown;
  try {
    logs = JSON.parse(text);
  } catch {
    out.warnings.push("sleep file is not valid JSON");
    return out;
  }
  if (!Array.isArray(logs)) return out;
  for (const raw of logs) {
    if (!raw || typeof raw !== "object") {
      out.skipped++;
      continue;
    }
    const log = raw as Record<string, unknown>;
    const date =
      typeof log.dateOfSleep === "string" && BARE_DAY.test(log.dateOfSleep)
        ? log.dateOfSleep
        : null;
    const start = typeof log.startTime === "string" ? log.startTime : undefined;
    const end = typeof log.endTime === "string" ? log.endTime : undefined;
    const ms = typeof log.duration === "number" ? log.duration : null;
    const total =
      ms != null ? boundedOrNull("sleep_min", Math.round(ms / 60000)) : null;
    if (!date || !start || !end || total == null || total <= 0) {
      out.skipped++;
      continue;
    }
    out.samples.push({
      metric: "sleep_min",
      date,
      start_time: start,
      end_time: end,
      value: total,
    });
    // The stage breakdown comes ONLY from a stage-scored log. A `classic` log — an
    // older tracker, or any session Fitbit did not stage-score, which in practice is
    // every nap — carries a summary in a DIFFERENT vocabulary: restless / awake /
    // asleep, not deep / light / rem / wake. Mapping it by shared key name takes
    // `awake` and silently drops `restless` and `asleep`, so a day with a classic nap
    // gained awake minutes with no other stage behind them and its breakdown stopped
    // summing to its own total — the same invariant #1562 restored on the Health
    // Connect path, broken from the other direction. The total is still taken above;
    // only the incomparable breakdown is refused.
    if (log.type !== "stages") continue;
    const levels = log.levels as Record<string, unknown> | undefined;
    const summary = levels?.summary as
      Record<string, { minutes?: unknown }> | undefined;
    if (!summary) continue;
    for (const [key, metric] of Object.entries(FITBIT_STAGE_METRIC)) {
      const mins = summary[key]?.minutes;
      const value =
        typeof mins === "number" ? boundedOrNull(metric, mins) : null;
      if (value == null || value <= 0) continue;
      out.samples.push({
        metric,
        date,
        start_time: `${start}#${key}`,
        end_time: end,
        value,
      });
    }
  }
  return out;
}

// ---- exercise ----
//
// One Fitbit exercise log → an activity. Unlike the Health Connect path there is no
// numeric enum to decode: Takeout writes the human name ("Outdoor Bike", "Swim",
// "Walk", "Spinning"), so the shared cardio-vs-sport keyword classification applies
// directly.
//
// Distance carries its own UNIT and it is not metric — a real archive stamps
// `"distance": 0.170877, "distanceUnit": "Mile"`. Storing that number as km would
// under-report a swim by 60%, so the unit is honoured and an unrecognized one drops
// the distance (never the session, matching the HC parser's field-level sanitizing).
const CARDIO_HINTS = [
  "run",
  "walk",
  "hik",
  "cycl",
  "bik",
  "swim",
  "row",
  "elliptic",
  "stair",
  "treadmill",
  "jog",
  "ski",
  "skat",
  "cardio",
  "spin",
];

const MILES_TO_KM = 1.609344;

export function fitbitDistanceKm(
  value: number | null,
  unit: string | null
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "kilometer" || u === "kilometers" || u === "km") return value;
  if (u === "mile" || u === "miles" || u === "mi") return value * MILES_TO_KM;
  if (u === "meter" || u === "meters" || u === "m") return value / 1000;
  return null;
}

// `MM/DD/YY HH:MM:SS` — US-ordered local wall time, the only form the JSON families
// use. Returns the calendar date and the "HH:MM" clock, both verbatim: this is the
// "HH:MM" <-> minutes-of-day. The activity clock fields are wall times, not
// instants, so an end past midnight wraps rather than rolling a date — matching how
// the Health Connect path derives its own end clock.
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHhmm(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// `MM/DD/YY HH:MM:SS` — US-ordered, and in UTC despite carrying no marker.
// Converted through the profile zone to the local date and "HH:MM" clock.
//
// The archive uses TWO timestamp conventions and they disagree, which is worth
// stating because guessing wrong is silent:
//
//   `06/13/26 13:05:01`        (US, space-separated)  -> UTC
//   `2026-07-25T23:14:30.000`  (ISO-ish, T-separated) -> LOCAL wall time
//
// Proven, not inferred. The same step record appears in both encodings — the JSON's
// `06/10/26 16:39:00` value 34 is the CSV's `2026-06-10T16:39:00Z,34,Radiance` — so
// the US form carries the same clock as an explicitly-Z timestamp. Independently,
// exercise logs read as local were landing every ride exactly 4 hours (this
// profile's offset) after the same ride recorded by Strava. The T-separated form is
// the opposite: a sleep session's 23:14:30 matches the 23:23 LOCAL onset Health
// Connect reports for that night, so it is already local and must NOT be converted.
//
// Reading the US form as local put activities 4 hours out and, worse, on the wrong
// DAY whenever an evening session fell after UTC midnight — a 21:07 local swim is
// stamped `06/15/26 01:07:21` and was filed under the 15th.
export function parseUsUtcStamp(
  s: string | undefined,
  tz: string
): { date: string; hhmm: string } | null {
  if (!s) return null;
  const m = s
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, mm, dd, yy, hh, mi, ss] = m;
  const d = new Date(`20${yy}-${mm}-${dd}T${hh}:${mi}:${ss ?? "00"}Z`);
  if (Number.isNaN(d.getTime()) || !inTimeWindow(d.getTime())) return null;
  const parts = zonedDateParts(tz, d);
  return { date: parts.date, hhmm: parts.hhmm };
}

export function parseExerciseJson(text: string, tz: string): TakeoutParsed {
  const out = emptyTakeoutParsed();
  let logs: unknown;
  try {
    logs = JSON.parse(text);
  } catch {
    out.warnings.push("exercise file is not valid JSON");
    return out;
  }
  if (!Array.isArray(logs)) return out;
  for (const raw of logs) {
    if (!raw || typeof raw !== "object") {
      out.skipped++;
      continue;
    }
    const log = raw as Record<string, unknown>;
    const stamp = parseUsUtcStamp(
      typeof log.startTime === "string" ? log.startTime : undefined,
      tz
    );
    const logId = log.logId;
    if (!stamp || (typeof logId !== "number" && typeof logId !== "string")) {
      out.skipped++;
      continue;
    }
    const name =
      typeof log.activityName === "string" && log.activityName.trim()
        ? log.activityName.trim()
        : "Workout";
    const norm = name.toLowerCase();
    const ms =
      typeof log.activeDuration === "number"
        ? log.activeDuration
        : typeof log.duration === "number"
          ? log.duration
          : null;
    const durationMin =
      ms != null ? boundedOrNull("duration_min", Math.round(ms / 60000)) : null;
    out.activities.push({
      external_id: `${FITBIT_TAKEOUT_ID}:${logId}`,
      date: stamp.date,
      type: CARDIO_HINTS.some((h) => norm.includes(h)) ? "cardio" : "sport",
      title: name,
      duration_min: durationMin,
      distance_km: boundedOrNull(
        "distance_km",
        fitbitDistanceKm(
          typeof log.distance === "number" ? log.distance : null,
          typeof log.distanceUnit === "string" ? log.distanceUnit : null
        )
      ),
      start_time: stamp.hhmm,
      // DERIVED from start + duration, not left null. The archive gives both, and the
      // end clock is what lets the import-review duplicate detector use its
      // high-confidence OVERLAPPING-WINDOW path: a Takeout export re-exports rides
      // Strava also recorded, so the same session lands twice under two providers and
      // double-counts in training totals. Without an end there is no window to
      // overlap, and detection falls back to the 10% duration/distance proximity
      // rule — which misses a ride whose distance one side didn't record at all
      // (measured: three real Strava/Takeout duplicate rides went undetected).
      // Wraps past midnight the same way the Health Connect path does, since this is
      // a wall clock rather than a date.
      end_time: minutesToHhmm(hhmmToMinutes(stamp.hhmm) + (durationMin ?? 0)),
      avg_hr:
        typeof log.averageHeartRate === "number"
          ? boundedOrNull("heart_rate_bpm", log.averageHeartRate)
          : null,
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
    const date = dayLabelDate(iso);
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
