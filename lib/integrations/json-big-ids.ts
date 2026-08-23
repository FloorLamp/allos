// Int64 ids preserved THROUGH the JSON parse (#3194).
//
// Strava mints segment-effort and lap ids as int64 — around 3.5×10^18, far past
// `Number.MAX_SAFE_INTEGER` (2^53 ≈ 9×10^15). `JSON.parse` gives every number a
// double, so those ids arrive ALREADY ROUNDED to the nearest representable value
// (spacing 512 at that magnitude), and `String(...)` on one then mints an external
// id whose low digits are simply wrong. Observed in prod: 1,036 stored
// `activity_segment_efforts.external_id` values ending `…860000`, `…779000`,
// `…909400` — shapes a real Strava id never has.
//
// It is not a display defect. Two effort ids as close as 1000 apart INSIDE ONE RIDE
// (measured on the owner's data) round to the SAME double, so they collide on
// `UNIQUE(profile_id, source, external_id)` and the write throws — which is what
// killed the ride-detail backfill at 48 of 208 for a fortnight.
//
// No reviver can fix it: by the time a reviver sees the value the digits are gone.
// So the digits are preserved in the TEXT, before parsing. Every unquoted integer
// under an id-shaped key that cannot survive a double round-trip is quoted, and
// reaches the mapper as the exact digit string `externalIdOf` will store.
//
// PRECISION-GATED ON PURPOSE, rather than "quote every id". A value that
// `String(Number(digits))` hands back unchanged is already faithful — storing it
// costs nothing and loses nothing — so quoting it would change the type of every
// id in every payload this app has ever parsed, for no gain. Strava's ACTIVITY ids
// (~1.5×10^10) and segment ids (~10^7) are in that set, and `mapStravaActivity`
// reads `rec.id` through a NUMBER reader — so the gate is also what stops this from
// turning every activity into a skip.
//
// PURE (no db, no fs, no fetch): it sits in the unit tier beside the directory's
// other pure/impure splits (raw-log-format.ts vs raw-log.ts, backfill-error.ts vs
// backfill-jobs.ts).

// An id-shaped key in KEY position — preceded by `{` or `,` — holding an unquoted
// integer. Requiring the opening brace or comma is what keeps the pass off digits
// that merely sit inside a string value; `parseJsonPreservingIds` covers the
// residue by falling back when the rewrite does not parse.
const ID_KEY_INTEGER_RE =
  /([{,]\s*"(?:id|[A-Za-z0-9]+_id)"\s*:\s*)(-?\d+)(?=\s*[,}])/g;

// Does this digit string survive a trip through a JS number unchanged? `String` on
// a double prints the shortest decimal that round-trips to the same double, so this
// is exactly "would parsing then stringifying give the digits back".
export function idSurvivesJsNumber(digits: string): boolean {
  return String(Number(digits)) === digits;
}

// Quote the id values that a double would corrupt, leaving every other byte alone.
export function quoteUnsafeIntegerIds(text: string): string {
  return text.replace(
    ID_KEY_INTEGER_RE,
    (whole, head: string, digits: string) =>
      idSurvivesJsNumber(digits) ? whole : `${head}"${digits}"`
  );
}

// The parse to use on any response whose ids this app stores.
export function parseJsonPreservingIds(text: string): unknown {
  const rewritten = quoteUnsafeIntegerIds(text);
  if (rewritten === text) return JSON.parse(text);
  try {
    return JSON.parse(rewritten);
  } catch {
    // The rewrite is a TEXT pass, so a payload carrying an id-shaped key inside a
    // STRING value (an athlete who named a ride `,"id":12345678901234567,`) could
    // be made invalid by it. The original text is what this app parsed before
    // #3194 — fall back to it rather than turning a readable response into a
    // thrown sync. The ids in that payload are mangled exactly as they were.
    return JSON.parse(text);
  }
}
