// Temporal brands distinguish calendar days, local clocks, and UTC serializations.
// Obtain them through existing validators/constructors; row assertions must match
// the column registry. The ESLint cast restriction catches spellings, not arbitrary
// type-system escapes. See docs/internals/time-model.md for the shared contract.

declare const LOCAL_DAY: unique symbol;
declare const LOCAL_TIME: unique symbol;
declare const CANONICAL_INSTANT: unique symbol;
declare const BARE_INSTANT: unique symbol;

// A real calendar day, attributed in the domain's local timezone.
export type LocalDay = string & { readonly [LOCAL_DAY]: true };

// A local HH:MM clock value; needs a date and zone to resolve to an instant.
export type LocalTime = string & { readonly [LOCAL_TIME]: true };

// UTC, second resolution, explicit Z: YYYY-MM-DDTHH:MM:SSZ.
export type CanonicalInstant = string & { readonly [CANONICAL_INSTANT]: true };

// UTC in SQLite's bare serialization: YYYY-MM-DD HH:MM:SS.
export type BareInstant = string & { readonly [BARE_INSTANT]: true };
