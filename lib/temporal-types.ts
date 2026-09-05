// THE TEMPORAL TYPE VOCABULARY (issue #2899).
//
// ── THE QUESTION THIS ANSWERS ────────────────────────────────────────────────
//
// "Is this string a day, a clock reading, or an instant — and if an instant, on which
// serialization?" lib/time-columns.ts already declares that per COLUMN, and
// lib/source-time.ts already distinguishes the three grains a SOURCE can state. Until
// #2899 nothing carried either answer into a function signature, so a profile-local day
// passed where an instant was wanted, or an "HH:MM" passed where a day was wanted, was
// a review question rather than a compile error. These brands state in the type what the
// registry already states in data.
//
// ── TWO AXES, NOT ONE ────────────────────────────────────────────────────────
//
// Grain and serialization are separate questions. `CanonicalInstant` and `BareInstant`
// are the SAME instant on two conventions, and SQLite compares them lexically
// (docs/internals/time-model.md, "Why it is enforced rather than documented"), so one
// `IsoInstant` brand over both would make the exact bug the writer scan exists to
// prevent look checked. That is why there are two instant brands and no umbrella.
//
// ── MINTERS VALIDATE OR CONSTRUCT; NOBODY ASSERTS ────────────────────────────
//
// A brand is worth exactly as much as the weakest way to obtain one. So a value of one
// of these types comes from a function that either VALIDATED a string (`isRealIsoDate`
// checks the calendar, not a regex) or CONSTRUCTED it from a `Date` (`utcInstant`).
// `x as LocalDay` on a plain string is an ESLint error everywhere
// (eslint.config.mjs, "no-restricted-syntax"); the minters carry the only permitted
// casts, each on a `// eslint-disable-next-line … -- <brand> minter:` line, so
// `grep -rn "minter:" lib` IS the minter inventory. A function that receives a string
// and casts it is not a minter and must not exist.
//
// The one place a brand may appear without a minter is a DB ROW SHAPE — the
// `.get(...) as { date: LocalDay }` assertion every read already makes. A row shape may
// carry the brand that lib/time-columns.ts declares for that column and nothing else:
// the registry is the evidence, and the column-index scan is what keeps it true.
//
// ── WHAT IS DELIBERATELY NOT A BRAND ─────────────────────────────────────────
//
// `metric_samples.started_at` / `ended_at` are NEVER `CanonicalInstant`. They hold two
// shapes by design — a vendor ISO-with-milliseconds instant and a `${day}T00:00:00`
// day-midnight anchor — inside the natural key that makes a re-push a correction, so
// a cast there would be a lie with an idempotency blast radius. `MetricSampleInstant`
// below is the truthful union of those two, each with its own minter. Normalising the
// stored values is #2896's question, not this module's.
//
// A brand is a subtype of `string`, so branding a function's RETURN breaks no caller;
// only narrowing a PARAMETER does, and that happens at each consumer as it is touched.
//
// PURE — no DB, no clock, no imports.

declare const LOCAL_DAY: unique symbol;
declare const LOCAL_TIME: unique symbol;
declare const CANONICAL_INSTANT: unique symbol;
declare const BARE_INSTANT: unique symbol;
declare const VENDOR_MS_INSTANT: unique symbol;
declare const DAY_MIDNIGHT_ANCHOR: unique symbol;

// "YYYY-MM-DD", a real calendar day, profile-local by attribution (#94). Minted by
// `isRealIsoDate` (validates) and by the day constructors in lib/date.ts and
// `today()` in lib/db.ts (construct through Date/Intl).
export type LocalDay = string & { readonly [LOCAL_DAY]: true };

// "HH:MM", a profile-local time of day — the #2883 grain. Needs a day AND a zone to
// become an instant. Minted by `zonedDateParts`, `nowTime` and `activityClockHHMM`.
export type LocalTime = string & { readonly [LOCAL_TIME]: true };

// "YYYY-MM-DDTHH:MM:SSZ" — UTC, second resolution, explicit Z. THE stored convention
// (#2205). Minted by `utcInstant`, `utcMinute`, `toUtcInstant`, `instantNow` and
// `sourceInstant`.
export type CanonicalInstant = string & { readonly [CANONICAL_INSTANT]: true };

// "YYYY-MM-DD HH:MM:SS" — SQLite's own datetime('now') shape, UTC with no zone
// stated. The legacy half of the convention. Minted by `utcSqlString` and `sqlNow`.
export type BareInstant = string & { readonly [BARE_INSTANT]: true };

// "YYYY-MM-DDTHH:MM:SS.mmmZ" — a JS toISOString that reached storage, as the device
// integrations write into metric_samples.
export type VendorMsInstant = string & { readonly [VENDOR_MS_INSTANT]: true };

// "YYYY-MM-DDT00:00:00" — a profile-local DAY's midnight, zoneless. Not an instant:
// the metric_samples window for a reading whose author stated only a day.
export type DayMidnightAnchor = string & {
  readonly [DAY_MIDNIGHT_ANCHOR]: true;
};

// What metric_samples.started_at / ended_at genuinely hold (lib/time-columns.ts,
// "THE column that most rewards reading this table"). A union, never a cast.
export type MetricSampleInstant = VendorMsInstant | DayMidnightAnchor;

// The day-midnight anchor for a day-only reading. CONSTRUCTS from a LocalDay, so the
// day inside is already a real calendar day.
export function dayMidnightAnchor(day: LocalDay): DayMidnightAnchor {
  // eslint-disable-next-line no-restricted-syntax -- DayMidnightAnchor minter: constructs from a LocalDay
  return `${day}T00:00:00` as DayMidnightAnchor;
}

// A vendor instant as the integrations serialize it. VALIDATES: the value must be a
// real instant that round-trips through toISOString byte-for-byte, so a truncated,
// zoneless or out-of-range value is refused rather than branded.
export function vendorInstant(
  v: string | null | undefined
): VendorMsInstant | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== v) return null;
  // eslint-disable-next-line no-restricted-syntax -- VendorMsInstant minter: validated by toISOString round-trip
  return v as VendorMsInstant;
}
