// Pure decision logic for the server error log (issue #596): truncation,
// redaction, and line parsing. No fs/network here so it's unit testable and
// safe to import from anywhere; the impure fs half lives in lib/error-log.ts,
// and the self-trim shared with ai.jsonl lives in lib/jsonl-trim.ts (#1841).

export type ErrorLevel = "error" | "warn";

// One persisted unexpected-error event. Mirrors the AiEvent shape (id/time +
// tags) so the admin surface can render it the same way.
export interface ErrorEvent {
  id: string;
  time: string;
  level: ErrorLevel;
  // The logger scope (createLogger("scope")) — which subsystem emitted it.
  scope?: string;
  message: string;
  // Serialized, redacted, capped fields (including any Error stack). Optional
  // because a bare log.error("boom") carries no fields.
  detail?: string;
  // Acting login/profile when a request context is in scope (withLogContext);
  // null in background/notify/CLI ticks.
  loginId?: number | null;
  profileId?: number | null;
}

// Bound any free-text detail so a stack trace or huge field dump can't balloon
// the file. Mirrors ai-log's capDetail.
export function capDetail(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}

// ---------------------------------------------------------------------------
// Key classification
//
// A key is sensitive because of the WORDS IN IT, not because it appears
// verbatim in a list (#2938). The old exact-match denylist held `apikey` and
// `api_key` but missed `X-Api-Key` on nothing but the dash, and held `session`
// but missed `sessionId` on nothing but the suffix. So the key is split into
// parts on separators and camelCase humps, and the parts are what we match.
// Growing a list by nine entries is the same defect with a longer list.

// Matched as a SUBSTRING of any one part: `sessiontoken`, `apikeys`, and
// `x_refreshtoken` all read the same way to a human, and none of these words
// has an innocent longer form worth protecting.
const SENSITIVE_SUBSTRINGS = [
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "token",
  "cookie",
  "credential",
  "signature",
  "authorization",
  "apikey",
  "jwt",
  "otp",
];

// Matched only as a WHOLE part. `auth` as a substring masks every `author`,
// `sig` masks `design` and `assign`.
//
// `pass` is NOT here. It reads as a credential everywhere else and as a RESULT
// in this app — `pass: 2 of 3 fitness norms met` is house copy, and masking the
// count is a defect the same way a leak is. `password`/`passwd`/`passphrase`
// carry the real cases.
const SENSITIVE_WHOLE_PARTS = new Set(["auth", "cred", "creds"]);

// `session` is a first-class DOMAIN noun here — `workoutSession`,
// `sleepSession`, `practiceSession` — and also names the cookie that
// authenticates a login. Position tells them apart: the credential leads
// (`session`, `sessionId`, `X-Session-Token`), the domain noun trails
// (`workoutSession`, `sleepSessionId`). Anything else matching `session`
// anywhere would mask 300-odd identifiers in this codebase's own logs.
const LEADING_ONLY_PARTS = ["session"];
// Prefixes skipped when deciding what "leads": `X-Session-Id` is a header.
const KEY_PREFIX_NOISE = new Set(["x", "http", "https"]);

// Keys that CONTAIN a sensitive word and are still diagnostic, not secret.
// `token_type=bearer` names the scheme, it is not the token.
const NEVER_SENSITIVE_KEYS = new Set([
  "tokentype",
  "tokenurl",
  "tokenendpoint",
  "sessionstate",
]);

// `key` alone is a generic word (`sort_key`, `cache_key`), so it only counts
// next to a qualifier. Adjacent parts are joined and looked up here.
const SENSITIVE_PART_PAIRS = new Set([
  "apikey",
  "accesskey",
  "signingkey",
  "clientkey",
  "appkey",
  "accountkey",
  "subscriptionkey",
]);

// Keys that are a credential in a URL and an ordinary field everywhere else.
// `code` is the OAuth exchange code AND the name Node gives every errno
// (`ECONNREFUSED`), so it is masked only when the VALUE also looks like a
// credential — see looksLikeCredential.
const SHAPE_GATED_KEYS = new Set([
  "code",
  "authcode",
  "authorizationcode",
  "oauthcode",
  "devicecode",
  "sig",
  "nonce",
  "assertion",
]);
// Same rule, but only inside a URL query, where the surrounding shape says the
// value is a protocol parameter rather than prose. `state` is a US state on a
// health record and a CSRF token in an OAuth redirect.
const SHAPE_GATED_QUERY_KEYS = new Set(["state", "signedrequest", "ticket"]);

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

function isSensitiveKey(key: string): boolean {
  const parts = keyParts(key);
  if (NEVER_SENSITIVE_KEYS.has(parts.join(""))) return false;
  const leadIndex = parts.findIndex((p) => !KEY_PREFIX_NOISE.has(p));
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (SENSITIVE_WHOLE_PARTS.has(part)) return true;
    if (SENSITIVE_SUBSTRINGS.some((w) => part.includes(w))) return true;
    if (i === leadIndex && LEADING_ONLY_PARTS.some((w) => part.includes(w))) {
      return true;
    }
  }
  for (let i = 0; i + 1 < parts.length; i++) {
    if (SENSITIVE_PART_PAIRS.has(parts[i] + parts[i + 1])) return true;
  }
  return false;
}

function isShapeGatedKey(key: string, inQuery: boolean): boolean {
  const joined = keyParts(key).join("");
  return (
    SHAPE_GATED_KEYS.has(joined) ||
    (inQuery && SHAPE_GATED_QUERY_KEYS.has(joined))
  );
}

// ---------------------------------------------------------------------------
// Value shapes
//
// Redaction must not turn a diagnosable error into an opaque one, so the
// shape tests below all exclude the things an operator reads an error FOR:
// errno constants, status codes, dates, and grant types.

// Credential-shaped enough to mask under an ambiguous key. Rejects
// `ECONNREFUSED` and `SQLITE_CONSTRAINT` (screaming case), `invalid_grant`
// (no digit), `400` and `20260815` (no letter), and anything short.
function looksLikeCredential(v: string): boolean {
  if (v.length < 12) return false;
  if (!/^[A-Za-z0-9%._~+/=-]+$/.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (/^[A-Z0-9_-]+$/.test(v)) return false;
  return true;
}

// An opaque identifier standing where a URL path segment or query value would
// be: a UUID, a JWT, a long unbroken hex/base64 run, or a long base64url token.
//
// The shapes are deliberately narrow at the SLUG boundary. A first cut matched
// any 20+ char `[A-Za-z0-9_-]` run with a digit in it, which also matches
// `comprehensive-metabolic-panel-2026` — a real path in a health app, and an
// error naming it is one an operator can act on. So a separator-bearing segment
// must ALSO carry mixed case, which opaque tokens do and lowercase slugs do
// not, and the unbroken form keeps the plain length floor.
function isOpaqueToken(v: string): boolean {
  if (isOpaqueTokenExact(v)) return true;
  // Strip at most two trailing extensions (`<token>.csv`, `<token>.tar.gz`).
  // This used to RECURSE per extension-looking suffix, with no depth bound: a
  // path of `x.a` repeated blew the stack outright, and `backfillErrorMessage`
  // has no guard, so the throw would escape the catch that marks a backfill job
  // `failed` and leave it stuck `running`. A bounded loop with lastIndexOf also
  // drops the `^(.+)\.` backtracking the old form paid for on every call.
  let stem = v;
  for (let i = 0; i < 2; i++) {
    const dot = stem.lastIndexOf(".");
    const ext = dot < 0 ? "" : stem.slice(dot + 1);
    if (dot <= 0 || ext.length > 5 || !/^[A-Za-z0-9]+$/.test(ext)) return false;
    stem = stem.slice(0, dot);
    if (isOpaqueTokenExact(stem)) return true;
  }
  return false;
}

function isOpaqueTokenExact(v: string): boolean {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  ) {
    return true;
  }
  if (/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) {
    return true;
  }
  if (/^[A-Za-z0-9]{20,}$/.test(v)) {
    return /[0-9]/.test(v) && /[A-Za-z]/.test(v);
  }
  if (/^[A-Za-z0-9_-]{24,}$/.test(v)) {
    return /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vendor-prefixed credentials (#2965, ruled 2026-08-16)
//
// Every other rule in this file needs CONTEXT — a key that names a credential,
// a scheme word, a position in a URL. These need none: the vendor guarantees
// the shape, so the value is a credential wherever it appears, including in
// prose and in an Error stack where there is no key to gate on. It is also the
// most likely remaining real leak, and since #2935 the string reaches a data
// subject's browser as well as the admin log.
//
// This is a denylist, which is the design #2955 deliberately replaced with
// shape-and-key matching, and a denylist accretes unless something states what
// it may hold. So:
//
// THE RULE FOR WHAT EARNS A PLACE ON THIS LIST — a prefix belongs here only if
// all three hold:
//   1. The VENDOR PUBLISHES it as reserved for credentials, in its own
//      documentation. Not inferred from a sample, not observed in the wild.
//   2. It is UNAMBIGUOUS AS A PREFIX WITH A BODY ON IT: nothing this app logs —
//      no English word, clinical term, file path, hostname or identifier — can
//      begin with it AND continue for eight or more `[A-Za-z0-9_-]` characters.
//      Stated that way because that is what the regex below actually matches,
//      and the two are not the same claim (#3000). The shorter version, "no
//      word can begin with it", was reasoned for the `_` prefixes and is false
//      for the `-` ones: a hyphen glues straight to the next English word, so
//      a Slack prefix written immediately before the word "prefixed" reads as a
//      credential to this rule, as does an underscore prefix written in front
//      of a snake_case phrase. That cost is accepted — a sentence loses one
//      word, against a credential that would otherwise print in full — but
//      condition 2 has to say so rather than imply the case cannot arise. What
//      condition 2 still rules out, and what the list is checked against, is a
//      prefix a REAL logged token could carry: the over-redaction corpus test
//      runs the app's own vocabulary through this rule and requires identity.
//      (Both examples are spelled out, executed, in that rule's own tests —
//      not written out here, because a literal in this file is a string in the
//      corpus, and this file's comments are not vocabulary the app logs.)
//   3. What follows it is the secret itself, so masking the tail costs an
//      operator nothing they read the error for — the prefix stays, and still
//      says which vendor's credential was involved.
// A prefix failing any of the three is a guess, and a list of guesses is the
// denylist #2955 removed. Shape-and-key matching remains the general rule; this
// is the stated exception to it, not the start of a second one.
const VENDOR_SECRET_PREFIXES = [
  // Stripe secret and restricted API keys.
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "rk_test_",
  // GitHub personal-access (classic and fine-grained), OAuth, user-to-server,
  // server-to-server and refresh tokens.
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  // Slack bot, user, app-level, refresh and legacy workspace tokens.
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxr-",
  "xoxs-",
  "xapp-",
  // Anthropic API keys. `lib/ai.ts` and `lib/medical-extract/extract.ts` both
  // construct an `@anthropic-ai/sdk` client from ANTHROPIC_API_KEY, so this is
  // the one credential on this list the deployment actually holds — and a 401
  // from that SDK is exactly the error text these two readers show (#3000).
  "sk-ant-",
];

// The body floor is what separates "a credential" from "a prefix named in
// prose", and it separates them on WHITESPACE: "rotate the ghp_ token" and
// "the xoxb- prefix" survive because the next character ends the match. A
// mention that glues the prefix to eight or more identifier characters does
// mask — see condition 2 above, which states that cost
// rather than claiming the floor prevents it. The floor also means
// `<prefix>***` cannot re-match, so redactSecrets stays idempotent.
const VENDOR_SECRET_RE = new RegExp(
  `\\b(${VENDOR_SECRET_PREFIXES.join("|")})[A-Za-z0-9_-]{8,}`,
  "g"
);

// Credential-shaped enough to follow an auth SCHEME word. `Bearer` never
// appears in prose so its argument is masked unconditionally; `Basic` does
// ("Basic Metabolic Panel"), so its argument must look encoded rather than
// written: a non-letter, or the internal case change that base64 of an
// `id:secret` pair has and an English word does not.
function looksLikeAuthCredential(v: string): boolean {
  if (v.length < 8 || !/^[A-Za-z0-9+/=_.~-]+$/.test(v)) return false;
  return /[^A-Za-z]/.test(v) || /[a-z][A-Z]/.test(v);
}

// ---------------------------------------------------------------------------
// URL redaction
//
// The failing request URL is the shape credentials actually travel in (#2820),
// and it went through the old key/value pass untouched: a token in a path
// segment has no key at all, and a presigned signature's key has dashes in it.
// The scheme, host and endpoint names survive — those are what the error is
// read for.
function redactParams(s: string): string {
  return s.replace(
    /([?&#])([^=&#]+)=([^&#]*)/g,
    (whole, sep: string, key: string, value: string) => {
      if (!value || value === "***") return whole;
      const mask =
        isSensitiveKey(key) ||
        isOpaqueToken(value) ||
        (isShapeGatedKey(key, true) && looksLikeCredential(value));
      return mask ? `${sep}${key}=***` : whole;
    }
  );
}

// Path, query and fragment — the part of a URL that exists whether or not the
// client reported an absolute one.
//
// The FRAGMENT is redacted on the same terms as the query, not returned
// verbatim. It is where the OAuth implicit flow puts `access_token=`, so
// treating it as decoration let a token pass while a token one character
// earlier in the path was masked.
function redactPathQueryHash(rest: string): string {
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(rest);
  if (!m) return rest;
  const [, path, query = "", hash = ""] = m;
  const safePath = path.replace(/[^/]+/g, (seg) =>
    isOpaqueToken(seg) ? "***" : seg
  );
  // A fragment with no `=` in it is a bare value, so it is judged by shape.
  const safeHash = hash.includes("=")
    ? redactParams(hash)
    : isOpaqueToken(hash.slice(1))
      ? "#***"
      : hash;
  return safePath + redactParams(query) + safeHash;
}

// The failing request URL is the shape credentials actually travel in (#2820),
// and it went through the old key/value pass untouched: a token in a path
// segment has no key at all, and a presigned signature's key has dashes in it.
// The scheme, host and endpoint names survive — those are what the error is
// read for.
function redactUrl(url: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(url);
  if (!m) return url;
  const [, scheme, rawAuthority, rest] = m;
  // `https://id:secret@host` — the whole userinfo goes, not just the password.
  const authority = rawAuthority.replace(/^[^@]*@/, "***@");
  return scheme + authority + redactPathQueryHash(rest);
}

// The scheme run is LENGTH-BOUNDED on purpose. Unbounded (`[A-Za-z0-9+.-]*`)
// it swallows the rest of the line at every start position and backtracks off
// the missing `://`, which made redaction quadratic in the detail length — a
// 32KB stack took 1.6s. Real schemes are under a dozen characters.
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/[^\s"'<>\\]+/g;

// A request line that reports the PATH ONLY — many clients render
// `GET /v2/measure/<token>/getactivity` and never the absolute form, so the
// same token was masked or not depending on how the client phrased it.
//
// Deliberately anchored to an HTTP METHOD rather than matching any `/…` run.
// Stack traces are mostly absolute paths, and `buildDetail` is mostly stack
// traces: an unanchored rule would start masking build-artifact hashes in the
// frames an operator reads the error for. A path-only URL that is not
// method-prefixed is a known remaining gap, recorded rather than guessed at.
const REQUEST_PATH_RE =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)([ \t]+)(\/[^\s"'<>\\]*)/g;

// `Bearer <token>` / `Basic <base64>` anywhere. The scheme word is KEPT and
// the credential is masked — the old rule did the reverse for Basic, masking
// the word `Basic` while the base64 survived, which produced a string that
// read as handled and was not (#2938).
const AUTH_SCHEME_RE =
  /\b(Bearer|Basic|Digest|Negotiate)([ \t]+)([^\s,;"'\\]+)/gi;

// `key=`, `key: `, `"key":` and the JSON-ESCAPED `\"key\":` that survives one
// round of JSON.stringify. The quote is a backreference, so the closing form
// has to match the opening one, escaped or not.
const KEY_RE = /(\\?["']|)([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s*[=:]\s*)/g;
// The value, read only once the key has earned it, anchored (sticky) at the
// position the key left off. Quoted first so a value with spaces in it is taken
// whole; the bare form stops at the delimiters a bare value cannot cross.
const VALUE_QUOTED_RE =
  /(\\?["'])((?:Bearer|Basic|Digest|Negotiate)[ \t]+)?((?:\\.|[^"'\\])*?)\1/y;
const VALUE_BARE_RE =
  /((?:Bearer|Basic|Digest|Negotiate)[ \t]+)?([^"'\s,;{}[\]&\\)]{1,512})/y;

// A number is never a credential. `{"sessionCount":14}` and `session=42` are
// counters, durations and ids, and masking them is not free: `redactBag` in
// lib/log.ts stringifies, redacts and RE-PARSES, so a single unquoted `***`
// makes the line invalid JSON and the whole field bag — `profileId` and every
// other field — collapses into one string. Quoting is the type marker on the
// text path, so `"42"` under a token key still masks; a bare 42 does not.
const NUMERIC_VALUE_RE = /^-?\d+(?:\.\d+)?$/;

// A bare colon-separated value that reads as a SENTENCE rather than a field.
// `Invalid session: please reconnect the integration` is a literal upstream
// Withings 401 that reaches a profile card, and it is indistinguishable from
// `key: value` to a regex. What separates them is what FOLLOWS: a field value
// ends its clause, prose keeps going in lowercase.
//
// The residual is deliberate and narrow — a secret written as two lowercase
// words after `password: ` is not masked. Every realistic credential carries a
// digit, a separator or a capital, none of which survive this test.
function looksLikeProse(s: string, valueStart: number, value: string): boolean {
  if (!/^(?:[a-z]{1,12}|[0-9]{1,4})$/.test(value)) return false;
  return /^\s+[a-z]/.test(s.slice(valueStart + value.length));
}

// How far to look for the close of a structured value before giving up.
const STRUCTURE_SCAN_LIMIT = 20000;

// The end of a `{…}` / `[…]` value hanging off a sensitive key, so the WHOLE
// structure can go rather than just its opening brace.
//
// Base replaced the brace alone — `{"session":***"id":"ada","v":"<secret>"}}` —
// which left the secret in the string and produced mangled JSON that merely
// looked redacted. That is the same failure mode as masking the word `Basic`
// and leaving the base64.
//
// Two passes. String-aware first, so a brace inside a quoted value cannot close
// the structure early. Then a plain brace count, which is what reads text whose
// quotes are escaped (`\"a\"`) and where the string-aware pass cannot find the
// delimiters at all.
function structuredValueEnd(s: string, start: number): number | null {
  const open = s[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  const limit = Math.min(s.length, start + STRUCTURE_SCAN_LIMIT);
  for (const stringAware of [true, false]) {
    let depth = 0;
    let quote = "";
    for (let i = start; i < limit; i++) {
      const ch = s[i];
      if (stringAware && quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (stringAware && (ch === '"' || ch === "'")) {
        quote = ch;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return i + 1;
    }
  }
  return null;
}

// Walk every `key <sep> value` in the string and mask the ones whose KEY says
// so. Driven by hand rather than String.replace for two reasons.
//
// When the key is NOT sensitive the scan resumes at the VALUE, not past it.
// Letting a generic key match consume the value is how
// `telegram refused: token=abc` stopped being redacted mid-fix — `refused:`
// matched first and swallowed `token=abc` whole.
//
// And the value is not matched at all until the key qualifies. Matching it
// eagerly is quadratic: a bare value runs to the next delimiter, so on a
// delimiter-poor 32KB detail every one of thousands of non-sensitive keys
// dragged a match across the whole remaining string (1.2s, measured).
function maskKeyedValues(s: string): string {
  KEY_RE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(s)) !== null) {
    const [whole, keyQuote, key, sep] = m;
    const valueStart = m.index + whole.length;
    KEY_RE.lastIndex = valueStart;
    const sensitive = isSensitiveKey(key);
    const gated = !sensitive && isShapeGatedKey(key, false);
    if (!sensitive && !gated) continue;

    let quote = "";
    let scheme: string;
    let value: string;
    let end: number;
    VALUE_QUOTED_RE.lastIndex = valueStart;
    const quoted = VALUE_QUOTED_RE.exec(s);
    if (quoted) {
      [, quote, scheme = "", value] = quoted;
      end = VALUE_QUOTED_RE.lastIndex;
    } else {
      VALUE_BARE_RE.lastIndex = valueStart;
      const bare = VALUE_BARE_RE.exec(s);
      if (bare) {
        [, scheme = "", value] = bare;
        end = VALUE_BARE_RE.lastIndex;
        if (value === "***") continue;
        if (NUMERIC_VALUE_RE.test(value)) continue;
        if (sep.includes(":") && looksLikeProse(s, valueStart, value)) continue;
      } else {
        // No bare or quoted value: the delimiters a value cannot cross are
        // exactly the brackets a STRUCTURE opens with, so this is where
        // `{"session":{…}}` and `{"tokens":[…]}` used to fall through
        // untouched. Take the whole structure.
        const structureEnd = structuredValueEnd(s, valueStart);
        if (
          structureEnd === null &&
          s[valueStart] !== "{" &&
          s[valueStart] !== "["
        ) {
          continue;
        }
        // Unbalanced or past the scan limit: what follows a sensitive key is
        // the structure's contents, so the rest of the string goes with it.
        end = structureEnd ?? s.length;
        scheme = "";
        value = "";
      }
      // Re-emit an unquoted value as a QUOTED `***` when the key was quoted:
      // that is a JSON context, and an unquoted mask there is what breaks the
      // re-parse in redactBag.
      if (!quoted) quote = keyQuote;
    }
    if (value === "***") continue;
    if (gated && !looksLikeCredential(value)) continue;

    matched = true;
    out += s.slice(cursor, valueStart) + `${quote}${scheme}***${quote}`;
    cursor = end;
    KEY_RE.lastIndex = end;
  }
  return matched ? out + s.slice(cursor) : s;
}

// Redact secret-looking values from a string before it's persisted. The error
// detail may carry Authorization headers, bot tokens, cookies, passwords, or a
// failing request URL, pulled in via a logged field or an error message. We
// mask the VALUE, keeping the key so the log still says "a token was involved"
// without leaking it.
//
// This is a CREDENTIAL filter, not a PII filter — see the note on buildDetail
// for why the two profile-facing and operator-facing readers share one rule.
// Idempotent: `***` is never re-masked, so a caller that already redacted
// (every recordAiEvent detail, the console echo in lib/log.ts) composes.
//
// THE ONE CHOKEPOINT (#2978, and the reason the vendor-prefix rule lands here).
// `redactingReplacer` runs this over every string leaf, `buildDetail` runs it
// once more over the joined text so Error stacks are covered, and the
// profile-facing column calls it directly with no replacer at all
// (lib/integrations/backfill-error.ts). A rule written into the replacer alone
// would therefore hold for the admin log and not for the browser — two policies
// again, which is the #2938 shape. Rules go in here.
export function redactSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(URL_RE, (url) => {
    // Prose punctuation that ended up glued to the URL is not part of it.
    const tail = /[.,;:!?)\]}]+$/.exec(url);
    const core = tail ? url.slice(0, -tail[0].length) : url;
    return redactUrl(core) + (tail ? tail[0] : "");
  });
  out = out.replace(
    REQUEST_PATH_RE,
    (_whole, method: string, gap: string, path: string) =>
      `${method}${gap}${redactPathQueryHash(path)}`
  );
  out = out.replace(
    AUTH_SCHEME_RE,
    (whole, schemeWord: string, gap: string, cred: string) => {
      if (cred === "***") return whole;
      const mask =
        /^bearer$/i.test(schemeWord) || looksLikeAuthCredential(cred);
      return mask ? `${schemeWord}${gap}***` : whole;
    }
  );
  out = maskKeyedValues(out);
  // LAST, and with no key required: a vendor-guaranteed prefix is a credential
  // wherever it stands, so this pass is the one that runs when no other rule
  // could see the value at all.
  //
  // The ORDER is load-bearing and it is this way round (#3000). This pass masks
  // a SUFFIX of the match and leaves `<prefix>***` behind, and every rule above
  // decides by CHARSET — `looksLikeCredential`, `looksLikeAuthCredential`,
  // `isOpaqueToken` all reject a value containing `*`. Running it first
  // therefore DISARMS them: `code=sk_live_<body>.<tail>` masked to
  // `code=sk_live_***.<tail>` is a value `maskKeyedValues` will no longer mask
  // whole, so the tail survives — the same string with a non-vendor prefix
  // masks entirely. Adding a vendor prefix made the string redact LESS, in a
  // function whose whole job is the opposite. Running last cannot do that: the
  // passes above have already had the untouched string, and this one only ever
  // masks more.
  return out.replace(VENDOR_SECRET_RE, (_whole, prefix: string) => `${prefix}***`);
}

// Redact each leaf as it is serialized, BEFORE JSON.stringify escapes it.
// Masking by key covers the value a text pass cannot reach at all: a whole
// nested object hanging off `credentials`.
//
// Gated on TYPE, not on the key alone. A number, boolean or null can never be
// a credential, and masking them anyway turns `{"sessionCount":14}` into
// `"***"` — the count is why the line was logged. The text path draws the same
// line off quoting, so both readers agree on what a number is.
//
// Exported because `redactBag` in lib/log.ts serializes the SAME shape for the
// console echo (#2966). One replacer, so the two readers cannot drift the way
// escape-then-redact and redact-then-escape drifted before.
//
// BOTH key rules live here, not only the unambiguous one. The shape gate below
// used to exist ONLY in the whole-string pass, so a reader that redacted
// per-leaf and skipped that pass silently lost it: `{ code: "<credential>" }`
// printed raw, because `code` is not sensitive by NAME. It is masked only when
// the VALUE also reads as a credential — `code` is the OAuth exchange code AND
// the name Node gives every errno, so `code: "ECONNREFUSED"` must survive. That
// benign half is why the regression was easy to miss: testing it proves nothing
// about the half that leaks.
//
// Strings only. `looksLikeCredential` reads a value's SHAPE, and an object has
// no shape to read — an object under an ambiguous key is not evidence of a
// credential the way it is under `credentials`.
export function redactingReplacer(key: string, value: unknown): unknown {
  const maskable =
    typeof value === "string" || (typeof value === "object" && value !== null);
  if (key !== "" && maskable && isSensitiveKey(key)) return "***";
  if (
    key !== "" &&
    typeof value === "string" &&
    isShapeGatedKey(key, false) &&
    looksLikeCredential(value)
  ) {
    return "***";
  }
  return typeof value === "string" ? redactSecrets(value) : value;
}

// Turn the logger's `fields` bag into a persisted detail string: pull the stack
// out of any Error, JSON the rest, then redact + cap. Returns undefined when
// there's nothing worth recording.
//
// REDACTION HAPPENS DURING SERIALIZATION, not after it (#2938). This used to
// stringify first and redact the result, and `JSON.stringify` escapes the
// quotes that the key/value rules key off: a third-party response body carried
// in a string field came out as `{\"access_token\":\"…\"}` and matched nothing.
// The admin error log was therefore LESS redacted than the profile-facing
// backfill-error column built from the same throw, which inverts the whole
// point of the asymmetry. Escape-then-redact cannot be fixed by adding
// patterns — the escaping is what defeats them.
//
// The final pass over the joined string stays: it covers the Error stacks,
// which are appended raw and never go through the replacer.
//
// ONE RULE FOR BOTH READERS. redactSecrets removes CREDENTIALS, and that is
// all it removes — an email address, an account id, a hostname or a clinical
// detail in an error survives here and in the profile-facing column alike.
// A second, stricter rule for the profile column is what created the two-policy
// bug in the first place; and the profile-facing reader is the data subject, so
// their own address in "no account linked for …" is the sentence they need to
// act on, not a disclosure.
//
// INFRASTRUCTURE DETAIL REACHING THE BROWSER IS A RULED, ACCEPTED COST
// (#2965, ruled 2026-08-16). This survives, unmasked, in the profile-facing
// column as well as the admin log:
//
//   ECONNREFUSED 10.0.7.31:8443 (allos-worker-02.internal) userid=41207755
//
// It is not a credential. For a self-hosting operator it is their own machine,
// and seeing it is how they fix a broken integration. On a hosted deployment it
// is internal topology in a data subject's browser, and that cost was weighed
// and accepted: giving the profile column an infrastructure-scrubbing pass of
// its own is the two-policy arrangement that produced #2938, and #2978 has
// since collapsed the shape gate into one chokepoint precisely so the two
// readers cannot drift.
//
// So this is not an oversight to tidy up. Do not add a profile-only pass
// without reopening #2965.
export function buildDetail(
  fields: Record<string, unknown> | undefined,
  cap = 4000
): string | undefined {
  if (!fields) return undefined;
  const parts: string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      parts.push(`${k}: ${v.stack || v.message}`);
    } else {
      rest[k] = v;
    }
  }
  if (Object.keys(rest).length > 0) {
    try {
      parts.push(JSON.stringify(rest, redactingReplacer) ?? String(rest));
    } catch {
      parts.push(redactSecrets(String(rest)));
    }
  }
  if (parts.length === 0) return undefined;
  return capDetail(redactSecrets(parts.join("\n")), cap);
}

export function parseErrorLine(line: string): ErrorEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o.id === "string" && typeof o.message === "string"
      ? (o as ErrorEvent)
      : null;
  } catch {
    return null;
  }
}
