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
// checks the calendar, not a regex, and is a type predicate — no cast at all) or
// CONSTRUCTED it from a `Date` (`utcInstant`). The constructing minters carry their one
// permitted cast on a `// eslint-disable-next-line … -- <brand> minter:` line. A
// function that receives a string and casts it is not a minter and must not exist.
//
// The cast ban (eslint.config.mjs, "no-restricted-syntax") is a RATCHET over spellings,
// not a proof. It refuses the ways of naming a brand as a cast target, as an alias, or
// as a renamed import/export that lib/__tests__/temporal-types.test.ts lists — and that
// list is the definition of what it catches. TypeScript's type grammar has more ways to
// name a type than any selector list (three falsifying passes on #5356 each found new
// ones: a re-alias, a renamed import, a type-parameter default, a string-literal
// specifier), so a spelling the test does not list is an addition — add the selector
// and the test row — never a refutation. What the rule does not chase at all, and
// says so: what a name RESOLVES to (an indexed access into a row type, an interface's
// heritage or call signature, an object literal whose METHOD returns a brand), a type
// predicate or assertion function that lies, an overload or `declare` signature, a
// generic launderer, `as any`, `as never`, `JSON.parse`, and `.js` files. Those are
// review's, exactly as they are for every other type in the tree; a reader sees each of
// them on one line, and the rule's existence changes nothing about that job.
//
// The one place a brand may appear without a minter is a DB ROW SHAPE — the
// `.get(...) as { date: LocalDay }` assertion every read already makes, or an alias or
// interface holding that shape. A row shape may carry the brand that lib/time-columns.ts
// declares for that column and nothing else: the registry is the evidence, and the
// column-index scan is what keeps it true.
//
// ── WHAT IS DELIBERATELY NOT A BRAND ─────────────────────────────────────────
//
// `metric_samples.started_at` / `ended_at` carry NO brand. They are the natural key
// that makes a re-push a correction, and they hold whatever each writer put there: the
// device's own value verbatim (with or without milliseconds, `Z` or an offset), a
// `${day}T00:00:00` day-midnight anchor, a `${day}THH:MM:SS` zoneless local datetime, a
// bare `YYYY-MM-DD`, and an `<ISO>#<stage>` key — see the registry note on that column,
// which does not claim that list is complete. A two-shape union was proposed and
// FALSIFIED against the real writers, twice (#2899, 2026-09-05). A truthful type for
// that column needs every writer inventoried first, and normalising the values is
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
