// Colon-formatted DURATIONS at the import door (issue #2322). Pure — no DB, no
// network.
//
// Clinical documents report a stress test's `Exercise Duration` with the unit
// `min:sec` and a colon-formatted value ("10:30"). That is not a number, so a reading
// stored that way can never plot, flag or trend: it sits in the analyte's series as an
// un-analysable string that LOOKS like a reading. Storing it is the bug — a row that
// claims to be a measurement and answers no question about a quantity.
//
// The discipline is lib/source-time.ts's, one level down: PRESERVE AT THE SOURCE'S OWN
// GRAIN, narrow per what the destination declares. The source states minutes AND
// seconds; the destination (`medical_records.value_num` + `unit`) declares one number
// in one unit. So the narrowing is to SECONDS:
//
//   • Seconds is the finest grain the source states, and every `mm:ss` value is an
//     exact whole number of them. Minutes would be lossy for most values — 10:20
//     becomes 10.3333…, a repeating decimal that no longer round-trips to the digits
//     the document printed, and the app would be inventing precision it then throws
//     away. Choosing the unit that keeps the source exact is the same call
//     `sourceDay` makes when it takes a source's stated digits over a derived form.
//   • It is UCUM `s`, so the unit is a real unit rather than a format description.
//
// And the other half, which is not optional: WHEN THE PARSE CANNOT PRODUCE A NUMBER,
// the caller DROPS the observation with a reason. A colon-formatted unit is the
// source declaring "this value is a duration"; a value that does not satisfy that
// declaration is not a measurement this app can hold, and storing the string anyway is
// exactly the defect this module exists to remove. Each door reports the drop through
// its own import-report channel, under the `unparsable_value` reason.

// The canonical unit a normalized duration is stored in — UCUM seconds.
export const DURATION_CANONICAL_UNIT = "s";

// The unit spellings that DECLARE a colon-formatted duration. Matching is on the UNIT,
// never on the value's shape: "120/80" and a time of day are colon/slash-ish strings
// that are emphatically not durations, and only the source's own unit can tell us
// which is which. Compared case-insensitively with internal whitespace removed.
const COLON_DURATION_UNITS = new Set([
  "min:sec",
  "min:secs",
  "mins:secs",
  "minutes:seconds",
  "mm:ss",
  "m:ss",
  "hr:min:sec",
  "hh:mm:ss",
  "h:mm:ss",
  "hours:minutes:seconds",
]);

// The grain of a colon-duration unit's LEADING field, in seconds. `min:sec` leads with
// minutes; `hh:mm:ss` leads with hours. Used only for a value that carries no colon at
// all (see normalizeDurationValue).
const LEADING_FIELD_SECONDS: Record<string, number> = {
  "min:sec": 60,
  "min:secs": 60,
  "mins:secs": 60,
  "minutes:seconds": 60,
  "mm:ss": 60,
  "m:ss": 60,
  "hr:min:sec": 3600,
  "hh:mm:ss": 3600,
  "h:mm:ss": 3600,
  "hours:minutes:seconds": 3600,
};

function unitKey(unit: string | null | undefined): string | null {
  if (unit == null) return null;
  const key = unit.replace(/\s+/g, "").toLowerCase();
  return key || null;
}

// Does this unit declare a colon-formatted duration?
export function isColonDurationUnit(unit: string | null | undefined): boolean {
  const key = unitKey(unit);
  return key != null && COLON_DURATION_UNITS.has(key);
}

// Parse a colon-formatted duration into whole SECONDS, or null when the text does not
// state one. Accepts `S`, `M:SS` and `H:MM:SS` (the field COUNT decides the grammar,
// which is how every clock-formatted value is read), with an optional fractional part
// on the last field. A non-leading field of 60 or more is rejected rather than carried
// — "10:75" is not 11:15, it is a value we do not understand.
//
// Fractional seconds are rounded to the nearest whole second: a document printing
// "10:30.4" is stating a second, not a millisecond, and the sub-second digit is
// measurement noise on an exercise clock rather than data.
export function parseColonDuration(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+(:\d+)*(\.\d+)?$/.test(s)) return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n) || n < 0) return null;
    // Only the FIRST field may exceed 59 ("90:00" is a legitimate 90 minutes).
    if (i > 0 && n >= 60) return null;
    total = total * 60 + n;
  }
  return Math.round(total);
}

export type DurationNormalization =
  // The unit does not declare a duration — this door has nothing to say; the caller
  // keeps the value exactly as it arrived.
  | { kind: "not-a-duration" }
  // A real number of seconds. `value`/`value_num`/`unit` replace what the source sent.
  | { kind: "normalized"; value: string; value_num: number; unit: string }
  // The unit declared a duration and the value did not state one. The caller must DROP
  // the observation and report `reason` — never store the string.
  | { kind: "unparsable"; reason: string };

// THE door-level decision, shared by every ingest path (#2322). Give it a reading's
// value text, its numeric value (when the source already resolved one) and its unit.
//
// ── WHICH FIELD WINS, when the two disagree ────────────────────────────────────
// THE TEXT DOES, whenever it carries a colon. The two fields cannot disagree in the
// deterministic parsers — a CDA PQ or a FHIR Quantity is structurally numeric, so a
// resolved number means there was no colon to read. They CAN disagree at the AI door,
// where a model reading a page that prints "10:30" will quite reasonably put 10 in the
// numeric field while carrying "10:30" in the text. Trusting the number there stores
// 600 s for a 630 s test: silently wrong, and valid-looking ever after — the exact
// failure this module exists to remove. A colon in the text is the source stating MORE
// GRAIN than the number can hold, and more grain wins.
//
// The number is the fallback, for a source that only ever resolved one.
//
// A value with NO colon under a colon-duration unit states only the unit's LEADING
// field — "10" under `min:sec` is ten minutes, "10" under `hh:mm:ss` is ten hours.
// That is the unit's own grammar being read, not a guess, and it is why a source that
// prints a bare number does not lose its reading.
export function normalizeDurationValue(
  value: string | null | undefined,
  valueNum: number | null | undefined,
  unit: string | null | undefined
): DurationNormalization {
  const key = unitKey(unit);
  if (key == null || !COLON_DURATION_UNITS.has(key))
    return { kind: "not-a-duration" };

  const normalized = (seconds: number): DurationNormalization => ({
    kind: "normalized",
    value: String(seconds),
    value_num: seconds,
    unit: DURATION_CANONICAL_UNIT,
  });

  const text = (value ?? "").trim();

  // The finer-grained field first. A colon text the parse can't read is NOT quietly
  // demoted to the coarser number: we do not understand what the source said, and a
  // plausible wrong number is worse than a reported refusal.
  if (text.includes(":")) {
    const seconds = parseColonDuration(text);
    if (seconds == null)
      return {
        kind: "unparsable",
        reason: `value "${text}" is not a ${unit} duration`,
      };
    return normalized(seconds);
  }

  // No colon anywhere: a resolved number is a count of the unit's leading field.
  if (typeof valueNum === "number" && Number.isFinite(valueNum)) {
    if (valueNum < 0)
      return {
        kind: "unparsable",
        reason: `negative duration "${valueNum}" in ${unit}`,
      };
    return normalized(Math.round(valueNum * LEADING_FIELD_SECONDS[key]));
  }

  if (!text)
    return {
      kind: "unparsable",
      reason: `no value carried for a ${unit} duration`,
    };

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0)
    return {
      kind: "unparsable",
      reason: `value "${text}" is not a ${unit} duration`,
    };
  const seconds = Math.round(n * LEADING_FIELD_SECONDS[key]);
  return normalized(seconds);
}
