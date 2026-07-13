// Pure decision logic for the server error log (issue #596): rotation,
// truncation, redaction, and line parsing. No fs/network here so it's unit
// testable and safe to import from anywhere; the impure fs half lives in
// lib/error-log.ts.

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

// Redact secret-looking values from a string before it's persisted. The error
// detail may carry Authorization headers, bot tokens, cookies, or passwords
// pulled in via a logged field or an error message. We mask the VALUE, keeping
// the key so the log still says "a token was involved" without leaking it.
export function redactSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  // `Bearer <token>` anywhere.
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***");
  // key=value or key: value or "key":"value" for sensitive key names. Covers
  // JSON, querystrings, and human-readable field dumps.
  const SENSITIVE =
    "password|passwd|pwd|secret|token|apikey|api_key|authorization|auth|cookie|set-cookie|session|client_secret|refresh_token|access_token";
  const kv = new RegExp(
    `("?(?:${SENSITIVE})"?\\s*[=:]\\s*)("?)([^"\\s,}&]+)(\\2)`,
    "gi"
  );
  out = out.replace(kv, (_m, pre, q) => `${pre}${q}***${q}`);
  return out;
}

// Turn the logger's `fields` bag into a persisted detail string: pull the stack
// out of any Error, JSON the rest, then redact + cap. Returns undefined when
// there's nothing worth recording.
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
      parts.push(JSON.stringify(rest));
    } catch {
      parts.push(String(rest));
    }
  }
  if (parts.length === 0) return undefined;
  return capDetail(redactSecrets(parts.join("\n")), cap);
}

// File is over budget → rewrite keeping only the newest lines. Bytes OR lines,
// whichever trips first, so a crash loop (many small lines) is bounded too.
export function shouldRotate(
  size: number,
  lineCount: number,
  maxBytes: number,
  maxLines: number
): boolean {
  return size > maxBytes || lineCount > maxLines;
}

// The newest `keep` non-empty lines, in order (oldest→newest of the kept set).
export function keepRecentLines(lines: string[], keep: number): string[] {
  return lines.filter(Boolean).slice(-keep);
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
