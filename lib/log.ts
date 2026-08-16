// Central leveled logger. Emits one line per event to stdout/stderr (so Docker's
// log driver captures everything). Format is human-readable `text` in
// development and structured `json` in production, overridable via LOG_FORMAT.
// Verbosity is controlled by LOG_LEVEL (default "info").
//
// Primarily server-side: reads process.env (shimmed to {} in browser bundles)
// and writes to the console. In a client bundle the error sink below is never
// registered (lib/error-log.ts only loads on the Node boot path), so a client
// consumer gets the structured console echo and nothing else — which is exactly
// what the ONE sanctioned client consumer wants: the #2183 theme-reassert
// diagnostic, a client-log-only event with no endpoint behind it. Don't add
// client imports casually; anything that must be SEEN by an admin needs a
// server-side path, because a browser console line reaches nobody.

// The SAME redaction chokepoint the persisted copies use (lib/error-log.ts via
// buildDetail, lib/ai-log.ts directly). error-log-format.ts is pure — no fs, no
// node builtins — so importing it here keeps log.ts Edge-safe.
import { redactSecrets, redactingReplacer } from "./error-log-format";

export type Level = "debug" | "info" | "warn" | "error";

// Optional persistence sink for surfaced failures (issue #596). log.ts stays
// pure-console and Edge-safe — it NEVER imports the fs-backed error log. Instead
// a server-only module (lib/error-log.ts, pulled in on the Node boot path via
// lib/db.ts) registers a sink here, and every `error` funnels into it so an
// admin can read unexpected errors after the fact. Left null in Edge/browser
// bundles (which never load error-log.ts), where fs is unavailable.
export interface LogSinkEvent {
  level: "error";
  scope?: string;
  msg: string;
  fields?: Record<string, unknown>;
}
type LogSink = (e: LogSinkEvent) => void;
let errorSink: LogSink | null = null;

export function registerErrorSink(sink: LogSink): void {
  errorSink = sink;
}

// SECOND persistence sink, filtered by SCOPE rather than by level (issue #2209).
//
// The error sink above is a LEVEL filter, and it is the only durable record the app
// has. Everything the notification tick says below `error` — "nothing due", "already
// sent today", "no channels configured for profile", every "… skipped: no channel",
// every reconcile outcome — lives only in the container's stdout, which the deploy
// timer deletes tens of times a day. The class of thing that is lost is exactly one:
// the DECLINE, a decision NOT to send, which by construction writes no row anywhere.
//
// So this sink takes a SCOPE predicate instead. It is deliberately NOT "persist every
// info": that would be the whole web app, which is a different and much larger
// decision. The registering module (lib/notify-log.ts) declares which scopes it
// admits and which levels are worth keeping; log.ts only carries the event across.
//
// Same posture as the error sink: registered by a server-only, fs-backed module on
// the Node boot path, left null in Edge/browser bundles, and best-effort — the sink
// guards its own failures so nothing here can throw into a caller's flow.
export interface LogScopeEvent {
  level: Level;
  scope?: string;
  msg: string;
  fields?: Record<string, unknown>;
}
type ScopeSink = (e: LogScopeEvent) => void;
let scopeSink: ScopeSink | null = null;

export function registerScopeSink(sink: ScopeSink): void {
  scopeSink = sink;
}

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function thresholdLevel(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

function useJson(): boolean {
  const fmt = (process.env.LOG_FORMAT || "").toLowerCase();
  if (fmt === "json") return true;
  if (fmt === "text") return false;
  return process.env.NODE_ENV === "production";
}

// Last-resort pass for a bag that can't be serialized at all (a cycle, a BigInt,
// a throwing toJSON). `JSON.stringify` refused it, so the replacer never ran and
// this has to do the replacer's job by hand.
//
// IT RECURSES, and that is the whole point (#2966). An earlier cut applied the
// replacer to TOP-LEVEL entries only. The replacer does not walk a tree on its
// own — `JSON.stringify` is what walks it — so everything under an ordinary key
// came back untouched and was then serialized raw by `emit`:
// `{ user: { password: "…" }, n: 10n }` printed the password. The version before
// that CRASHED on the same bag rather than leaking it, so a shallow walk here
// trades an availability defect for a confidentiality one on the same input.
// That is a worse bug than the one this file set out to fix.
//
// It must also hand back something `emit` can RENDER. Both render paths below
// serialize what they are given, so returning the offending value intact merely
// moved the throw out of redactBag's try and into the caller's — and the logger
// is called from error handlers, where a crash replaces the failure someone was
// trying to record. Every leaf that will not serialize is coerced to a string,
// cycles become a marker, and the walk is depth-capped: this path exists because
// the input was already pathological, so it assumes nothing about its shape.
const FALLBACK_MAX_DEPTH = 6;

function serializes(v: unknown): boolean {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

// `String(v)` is NOT total: an object with a null prototype, or one whose
// toString/valueOf throw, raises "Cannot convert object to primitive value".
// This is the fallback's fallback, so it cannot be the thing that throws.
function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "[unrenderable]";
  }
}

function redactDeep(
  key: string,
  value: unknown,
  path: Set<object>,
  depth: number
): unknown {
  const masked = redactingReplacer(key, value);
  if (typeof masked !== "object" || masked === null) {
    return serializes(masked) ? masked : redactSecrets(safeString(masked));
  }
  // Cycles are tracked along the current PATH, not globally: the same object
  // appearing twice as a sibling is a repeat, not a cycle, and rendering it
  // twice is honest.
  if (path.has(masked)) return "[circular]";
  if (depth >= FALLBACK_MAX_DEPTH) return "[truncated]";
  path.add(masked);
  try {
    if (Array.isArray(masked)) {
      return masked.map((v, i) => redactDeep(String(i), v, path, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(masked)) {
      // Function-valued properties are dropped, which is what JSON.stringify
      // does with them anyway — with ONE exception that matters here: it INVOKES
      // `toJSON`. Copying a throwing `toJSON` onto the rebuilt object rebuilds
      // the hazard we are escaping, and the throw then lands in `emit`, outside
      // every try on this path.
      if (typeof v === "function") continue;
      out[k] = redactDeep(k, v, path, depth + 1);
    }
    return out;
  } catch {
    // A throwing getter or an exotic proxy: fall back to the string form rather
    // than letting the walk escape into the caller.
    return redactSecrets(safeString(masked));
  } finally {
    path.delete(masked);
  }
}

function redactValues(bag: Record<string, unknown>): Record<string, unknown> {
  const path = new Set<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    out[k] = redactDeep(k, v, path, 0);
  }
  // The one hard guarantee this path owes `emit`: what it returns SERIALIZES.
  // Everything above is best-effort structure preservation; this is the floor,
  // checked once on an already-degraded bag. Without it "the logger never
  // throws" is a hope about having enumerated every hostile shape, and the
  // null-prototype `toJSON` proved that enumeration wrong once already.
  return serializes(out) ? out : { redacted: "[unrenderable field bag]" };
}

// Mask secret-looking values in the console echo (#1882). `docker logs` is a
// BROADER audience than the admin-only errors.jsonl viewer — ops tooling, log
// aggregation, anyone with container access — so it gets the SAME treatment from
// the SAME chokepoint the persisted copy uses, not a second policy.
//
// REDACTION HAPPENS DURING SERIALIZATION, not after it (#2966). This used to
// stringify the whole bag and redact the resulting text, which is the ordering
// #2938 condemned and #2955 fixed for buildDetail: `JSON.stringify` escapes the
// quotes the key/value rules key off, so a field holding JSON came out as
// `{\"access_token\":\"…\"}` and every extra level of nesting escaped again.
// It survived only because #2955's key rule happens to match the SINGLE-escaped
// `\"key\":` form — protection resting on a coincidence, with a real leak one
// level further down (a field holding JSON that itself holds JSON matched
// nothing). Sharing buildDetail's replacer fixes the ordering instead of adding
// another pattern; escaping is what defeats patterns.
//
// Two consequences worth stating, because both were bugs before:
//
//   * The output is valid JSON BY CONSTRUCTION. The replacer substitutes whole
//     values, so it can no longer emit an unquoted `***` mid-object. The old
//     `{redacted: …}` collapse — where one over-masked field took the entire
//     bag, `profileId` included, into a single opaque string — is gone, and with
//     it the log line an operator could not act on.
//   * The replacer is gated on TYPE, so a number, boolean or null under a
//     sensitive key keeps its value. `{ sessionCount: 42 }` and
//     `{ tokenValid: false }` are counters and flags; masking them is a defect
//     the same way a leak is.
//
// Nothing changes when nothing matches: an untouched bag is returned as-is (so
// the JSON round trip cannot reshape values it had no reason to touch), and
// redactSecrets is idempotent, so text a caller already redacted (every
// recordAiEvent detail/error, #1842) passes through unchanged rather than
// double-masked.
//
// Error stacks need no final whole-string pass here, unlike buildDetail:
// normalizeFields has already turned every Error into plain strings that go
// through the replacer like any other leaf.
function redactBag(bag: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const replacer = (key: string, value: unknown): unknown => {
    const next = redactingReplacer(key, value);
    if (next !== value) changed = true;
    return next;
  };
  let json: string | undefined;
  try {
    json = JSON.stringify(bag, replacer);
  } catch {
    return redactValues(bag);
  }
  if (json === undefined) return redactValues(bag);
  if (!changed) return bag;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    // Unreachable via the replacer, which only ever substitutes whole values.
    // Kept as a floor so a future replacer change degrades to less structure
    // rather than to an unmasked line.
    return redactValues(bag);
  }
}

// Pull a serializable shape out of an Error (or anything) passed in fields.err,
// then redact what comes out.
function normalizeFields(
  fields: Record<string, unknown> | undefined,
  debug: boolean
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = debug ? { message: v.message, stack: v.stack } : v.message;
    } else {
      out[k] = v;
    }
  }
  return redactBag(out);
}

function emit(
  level: Level,
  scope: string | undefined,
  msg: string,
  fields?: Record<string, unknown>
) {
  // Persist `error`-level events even when they're below the stdout threshold
  // (LOG_LEVEL) — the admin error surface is the point, and a raised threshold
  // shouldn't hide unexpected failures from it. Best-effort; the sink never
  // throws into the caller (guarded inside error-log.ts).
  if (level === "error" && errorSink) {
    errorSink({ level: "error", scope, msg, fields });
  }
  // The scope sink runs BEFORE the threshold check for the same reason the error
  // sink does: the persisted operator record is the point, and a raised LOG_LEVEL
  // must not silently empty it. The sink applies its own level floor (#2209 —
  // `debug` is developer tracing, not an operator record) so raising LOG_LEVEL
  // never adds lines here either.
  if (scopeSink) {
    scopeSink({ level, scope, msg, fields });
  }
  if (LEVELS[level] < thresholdLevel()) return;
  const time = new Date().toISOString();
  // Redact BOTH halves of the console echo, exactly as recordErrorEvent redacts
  // both the message and the built detail before persisting (#1882). Every level
  // gets it, not just warn/error: `docker logs` has one audience regardless of
  // the level that wrote the line.
  const safeMsg = redactSecrets(msg);
  const f = normalizeFields(fields, level === "debug");
  const sink =
    level === "warn" || level === "error" ? console.error : console.log;

  // useJson is a plain config helper, not a React hook — silence the false
  // positive the `use` prefix triggers in the rules-of-hooks lint rule.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (useJson()) {
    sink(JSON.stringify({ time, level, scope, msg: safeMsg, ...f }));
    return;
  }
  // Human-readable text: `time LEVEL [scope] msg key=value …`
  const tail = f
    ? " " +
      Object.entries(f)
        .map(
          ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`
        )
        .join(" ")
    : "";
  sink(
    `${time} ${level.toUpperCase()} ${scope ? `[${scope}] ` : ""}${safeMsg}${tail}`
  );
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope?: string): Logger {
  return {
    debug: (msg, fields) => emit("debug", scope, msg, fields),
    info: (msg, fields) => emit("info", scope, msg, fields),
    warn: (msg, fields) => emit("warn", scope, msg, fields),
    error: (msg, fields) => emit("error", scope, msg, fields),
  };
}

export const log = createLogger();
