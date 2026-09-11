// Tolerant field reads for VENDOR SYNC PAYLOADS. Every source's JSON arrives as
// `unknown`: a field can be absent, null, the wrong type, or spelled differently
// across API versions, and a single bad field must never take down a whole page of
// otherwise-good records. These are the one answer to "what is this field, if it is
// anything"; each source module used to carry its own verbatim copy (#4552).
//
// Payloads only. A value the app itself wrote knows its own shape and should not be
// laundered through `unknown` — see `cfgStr` in ./connections.ts, which reads stored
// config and deliberately does NOT trim.

// The first argument that is a finite number, else null. Variadic because vendors
// rename a field across API versions and one record may carry either spelling; the
// one-argument call is just the single-field case. Rejects NaN and ±Infinity, which
// JSON.parse can produce from a numeric string the vendor botched, and which would
// otherwise reach a numeric column.
export function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// A non-blank string, trimmed. Blank-after-trim is null, so incidental padding never
// becomes a stored value and an empty field reads the same as an absent one.
export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// A YYYY-MM-DD `day` field, validated so a malformed value can't become a row date.
// Shape only: this accepts an impossible calendar date such as 2026-02-30, matching
// the per-source copies it replaces. lib/date.ts's `isRealIsoDate` is the stricter
// calendar check; tightening to it would change what these syncs skip, so it is a
// separate decision rather than a side effect of the fold.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dayStr(v: unknown): string | null {
  const s = str(v);
  return s && DAY_RE.test(s) ? s : null;
}
