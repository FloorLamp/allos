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
  "session",
  "credential",
  "signature",
  "authorization",
  "apikey",
  "jwt",
  "otp",
];

// Matched only as a WHOLE part. `auth` as a substring masks every `author`,
// `sig` masks `design` and `assign`, `pass` masks `bypass` and `passed`.
const SENSITIVE_WHOLE_PARTS = new Set(["auth", "pass", "cred", "creds"]);

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
  for (const part of parts) {
    if (SENSITIVE_WHOLE_PARTS.has(part)) return true;
    if (SENSITIVE_SUBSTRINGS.some((w) => part.includes(w))) return true;
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
  const stem = /^(.+)\.[A-Za-z0-9]{1,5}$/.exec(v);
  if (stem && isOpaqueToken(stem[1])) return true;
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
function redactUrl(url: string): string {
  const m =
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(
      url
    );
  if (!m) return url;
  const [, scheme, rawAuthority, path, query = "", hash = ""] = m;
  // `https://id:secret@host` — the whole userinfo goes, not just the password.
  const authority = rawAuthority.replace(/^[^@]*@/, "***@");
  const safePath = path.replace(/[^/]+/g, (seg) =>
    isOpaqueToken(seg) ? "***" : seg
  );
  const safeQuery = query.replace(
    /([?&])([^=&]+)=([^&]*)/g,
    (whole, sep: string, key: string, value: string) => {
      if (!value || value === "***") return whole;
      const mask =
        isSensitiveKey(key) ||
        isOpaqueToken(value) ||
        (isShapeGatedKey(key, true) && looksLikeCredential(value));
      return mask ? `${sep}${key}=***` : whole;
    }
  );
  return scheme + authority + safePath + safeQuery + hash;
}

// The scheme run is LENGTH-BOUNDED on purpose. Unbounded (`[A-Za-z0-9+.-]*`)
// it swallows the rest of the line at every start position and backtracks off
// the missing `://`, which made redaction quadratic in the detail length — a
// 32KB stack took 1.6s. Real schemes are under a dozen characters.
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/[^\s"'<>\\]+/g;

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
    const [whole, , key] = m;
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
      if (!bare) continue;
      [, scheme = "", value] = bare;
      end = VALUE_BARE_RE.lastIndex;
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
    AUTH_SCHEME_RE,
    (whole, schemeWord: string, gap: string, cred: string) => {
      if (cred === "***") return whole;
      const mask =
        /^bearer$/i.test(schemeWord) || looksLikeAuthCredential(cred);
      return mask ? `${schemeWord}${gap}***` : whole;
    }
  );
  return maskKeyedValues(out);
}

// Redact each leaf as it is serialized, BEFORE JSON.stringify escapes it.
// Masking by key covers the values a text pass cannot reach at all: a number,
// or a whole nested object hanging off `credentials`.
function redactingReplacer(key: string, value: unknown): unknown {
  if (key !== "" && isSensitiveKey(key)) return "***";
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
