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
// THE GATE IS EXACT AT 2^53, both directions (measured): `9007199254740992` is
// left alone because it is exactly representable, while `9007199254740993` and
// `-9007199254740993` are quoted.
//
// ONE INPUT CHANGES A THROW INTO A VALUE, and it is recorded here so the next
// reader does not have to rediscover it: `{"id":003500000000000000123}` is invalid
// JSON (the spec forbids leading zeros) and `JSON.parse` rejects it, but the digit
// run matches, fails the round-trip gate, and comes back as the STRING
// `"003500000000000000123"`. Not a defect and not reachable from Strava — no
// compliant serializer emits a leading zero — but it is the one shape where this
// pass is not outcome-preserving.
//
// PURE (no db, no fs, no fetch): it sits in the unit tier beside the directory's
// other pure/impure splits (raw-log-format.ts vs raw-log.ts, backfill-error.ts vs
// backfill-jobs.ts).

// An id-shaped key in KEY position — preceded by `{` or `,` — holding an unquoted
// integer.
//
// WHAT KEEPS THIS OFF STRING VALUES is the unescaped `"` this pattern requires
// right after the `{` or `,`, and JSON's own escaping rule. Inside a string value
// every `"` is written `\"`, so the byte following any `{` or `,` that sits inside
// a string is a backslash, never a quote — the pattern cannot match there at all.
// A ride NAMED `,"id":12345678901234567,` reaches the wire as
// `"name":",\"id\":12345678901234567,"` and is left completely alone (measured).
// So this is not "usually safe on string values"; it is unreachable on them for
// any input that is valid JSON.
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
    // THIS FALLBACK CANNOT RESCUE A VALID PAYLOAD, and the comment that stood here
    // said otherwise — it claimed the rewrite could break a response carrying an
    // id-shaped key inside a string value, and gave an example that is not
    // rewritten at all (see the escaping note on ID_KEY_INTEGER_RE). Every match
    // this pass makes is in a real value position, and swapping a number for a
    // string there always leaves valid JSON. No input was found where the rewrite
    // fires and the result stops parsing while the original still parses.
    //
    // What it DOES do, measured: on a body that was already broken — a truncated
    // response, say — it re-parses the ORIGINAL, so the SyntaxError names the
    // offset in the bytes the server actually sent instead of a shifted one.
    // `{"id":3500000000000000123,` reports position 26 through here and 28 from
    // the rewritten text. That is small, and it is the whole of the reason to keep
    // a belt on untrusted upstream bytes; it is not a rescue path.
    return JSON.parse(text);
  }
}
