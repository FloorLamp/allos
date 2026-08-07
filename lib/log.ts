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
import { redactSecrets } from "./error-log-format";

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
// a throwing toJSON): mask the string values one at a time so something is still
// masked. Same chokepoint, less key context — which is why it is the fallback and
// not the rule.
function redactValues(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

// Mask secret-looking values in the console echo (#1882). `docker logs` is a
// BROADER audience than the admin-only errors.jsonl viewer — ops tooling, log
// aggregation, anyone with container access — so it gets the SAME treatment from
// the SAME chokepoint the persisted copy uses, not a second policy.
//
// The bag is masked WHOLE, the way buildDetail() feeds the persisted copy: the
// redaction keys off `key: value` text, so serializing first is what lets
// `{ authorization: "<bare token>" }` mask at all. The structure is then restored
// so the JSON format stays parseable. Masking CAN turn an unquoted value
// (`"session":42` → `"session":***`) into invalid JSON, and an aggregator reading
// `docker logs` should not have to cope with that — so when the round trip fails
// the masked text is emitted as one string field. That loses the field shape,
// never the masking: redaction is the point of the exercise.
//
// Nothing changes when nothing matches: an untouched bag is returned as-is, and
// redactSecrets is idempotent, so text a caller already redacted (every
// recordAiEvent detail/error, #1842) passes through unchanged rather than
// double-masked.
function redactBag(bag: Record<string, unknown>): Record<string, unknown> {
  let json: string | undefined;
  try {
    json = JSON.stringify(bag);
  } catch {
    return redactValues(bag);
  }
  if (json === undefined) return redactValues(bag);
  const masked = redactSecrets(json);
  if (masked === json) return bag;
  try {
    return JSON.parse(masked) as Record<string, unknown>;
  } catch {
    return { redacted: masked };
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
