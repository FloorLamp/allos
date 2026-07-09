// Central leveled logger. Emits one line per event to stdout/stderr (so Docker's
// log driver captures everything). Format is human-readable `text` in
// development and structured `json` in production, overridable via LOG_FORMAT.
// Verbosity is controlled by LOG_LEVEL (default "info").
//
// Server-only: reads process.env and writes to the console at module scope; do
// not import from client components.

export type Level = "debug" | "info" | "warn" | "error";

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

// Pull a serializable shape out of an Error (or anything) passed in fields.err.
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
  return out;
}

function emit(
  level: Level,
  scope: string | undefined,
  msg: string,
  fields?: Record<string, unknown>
) {
  if (LEVELS[level] < thresholdLevel()) return;
  const time = new Date().toISOString();
  const f = normalizeFields(fields, level === "debug");
  const sink =
    level === "warn" || level === "error" ? console.error : console.log;

  // useJson is a plain config helper, not a React hook — silence the false
  // positive the `use` prefix triggers in the rules-of-hooks lint rule.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (useJson()) {
    sink(JSON.stringify({ time, level, scope, msg, ...f }));
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
    `${time} ${level.toUpperCase()} ${scope ? `[${scope}] ` : ""}${msg}${tail}`
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
