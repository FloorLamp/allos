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
// A cast to a brand — direct, through `unknown`, inside a union, an array, a tuple, an
// intersection, a `NonNullable<>`, a qualified or `import()` name, or a bare re-alias
// `type D = LocalDay` — is an ESLint error everywhere (eslint.config.mjs,
// "no-restricted-syntax"); the minters carry the only permitted casts, each on a
// `// eslint-disable-next-line … -- <brand> minter:` line, so `grep -rn "minter:" lib`
// IS the minter inventory. A function that receives a string and casts it is not a
// minter and must not exist. What no syntax rule can see — `as any`, `as never`, a
// generic launderer, `JSON.parse` — is review's, as it is for every other type.
//
// The one place a brand may appear without a minter is a DB ROW SHAPE — the
// `.get(...) as { date: LocalDay }` assertion every read already makes. A row shape may
// carry the brand that lib/time-columns.ts declares for that column and nothing else:
// the registry is the evidence, and the column-index scan is what keeps it true.
//
// ── WHAT IS DELIBERATELY NOT A BRAND ─────────────────────────────────────────
//
// `metric_samples.started_at` / `ended_at` carry NO brand. They are the natural key
// that makes a re-push a correction, and they hold at least four shapes — the device's
// own instant verbatim (ISO with or without milliseconds), a `${day}T00:00:00`
// day-midnight anchor, and a `${day}THH:MM:SS` zoneless local datetime — see the
// registry note on that column. A union was proposed and FALSIFIED against the real
// writers (#2899, 2026-09-05): it modelled the note, not the column. A truthful type
// for that column needs the writers inventoried first, and normalising the values is
// #2896's question. Until then the column is `string`, and saying so is the point.
//
// A brand is a subtype of `string`, so branding a function's RETURN breaks no caller;
// only narrowing a PARAMETER does, and that happens at each consumer as it is touched.
//
// PURE — no DB, no clock, no imports.

declare const LOCAL_DAY: unique symbol;
declare const LOCAL_TIME: unique symbol;
declare const CANONICAL_INSTANT: unique symbol;
declare const BARE_INSTANT: unique symbol;

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
