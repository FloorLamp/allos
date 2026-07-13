// Persisted server error log (issue #596). Generalizes the notify_last_error
// pattern: instead of only a handful of subsystems surfacing their failures, EVERY
// unexpected `error` that funnels through createLogger() (an unhandled exception in
// a Server Action, a route 500, a crashed fire-and-forget extraction) is appended
// as a JSON line to data/logs/errors.jsonl and shown in the admin-only
// Settings → Errors tab. Clients still get the generic "internal error" (#478); the
// real cause lands here only.
//
// Multi-user: an error detail may carry PHI-adjacent text (like ai.jsonl does), so
// each event is tagged with the acting loginId/profileId when a request context is
// in scope (see withLogContext) and the surface is admin-only.
//
// Server-only: uses node:fs. Registers itself as log.ts's error sink at import;
// it's pulled onto the Node boot path from lib/db.ts, so it never reaches the Edge
// middleware or a client bundle (where fs is unavailable).

import fs from "node:fs";
import path from "node:path";
import { registerErrorSink, type LogSinkEvent } from "./log";
import { getLogContext } from "./log-context";
import {
  buildDetail,
  capDetail,
  keepRecentLines,
  parseErrorLine,
  redactSecrets,
  shouldRotate,
  type ErrorEvent,
} from "./error-log-format";

export type { ErrorEvent } from "./error-log-format";

export const ERROR_LOG_PATH = path.join(
  process.cwd(),
  "data",
  "logs",
  "errors.jsonl"
);

// Keep the file bounded so a crash loop can't fill the disk: rewrite with the
// newest lines when EITHER budget trips.
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_LINES = 2000;

// Monotonic-ish id within a process: time + counter so events appended in the
// same millisecond still sort/resume correctly.
let seq = 0;
function nextId(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now()}-${seq.toString().padStart(6, "0")}`;
}

function ensureDir() {
  fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
}

function trimIfLarge() {
  try {
    const { size } = fs.statSync(ERROR_LOG_PATH);
    // Cheap byte check first; only read the whole file to count lines when the
    // byte budget is already blown (avoids reading it on every append).
    if (size <= MAX_BYTES) return;
    const lines = fs.readFileSync(ERROR_LOG_PATH, "utf8").split("\n");
    if (!shouldRotate(size, lines.length, MAX_BYTES, KEEP_LINES)) return;
    fs.writeFileSync(
      ERROR_LOG_PATH,
      keepRecentLines(lines, KEEP_LINES).join("\n") + "\n"
    );
  } catch {
    // best-effort
  }
}

// Guards against re-entrancy: recordErrorEvent's own fs failure below is logged
// through the central logger, whose error sink is THIS function — without the
// guard a persistent write failure would recurse until the stack blows.
let writing = false;

// Append one error event. Best-effort — never throws into the caller's flow.
export function recordErrorEvent(e: LogSinkEvent): void {
  if (writing) return;
  writing = true;
  try {
    const ctx = getLogContext();
    const event: ErrorEvent = {
      id: nextId(),
      time: new Date().toISOString(),
      level: e.level,
      scope: e.scope,
      message: capDetail(redactSecrets(e.msg), 1000),
      detail: buildDetail(e.fields),
      loginId: ctx?.loginId ?? null,
      profileId: ctx?.profileId ?? null,
    };
    ensureDir();
    fs.appendFileSync(ERROR_LOG_PATH, JSON.stringify(event) + "\n");
    trimIfLarge();
  } catch {
    // Deliberately swallowed: we're already in the error path, and the raw
    // failure still went to stdout via the console emit in log.ts. Re-logging
    // here would just spin the re-entrancy guard.
  } finally {
    writing = false;
  }
}

// Newest-first, capped — for the SSR'd admin table.
export function readErrorEvents(limit = 200): ErrorEvent[] {
  try {
    const lines = fs.readFileSync(ERROR_LOG_PATH, "utf8").split("\n");
    const events: ErrorEvent[] = [];
    for (const line of lines) {
      const ev = parseErrorLine(line);
      if (ev) events.push(ev);
    }
    return events.slice(-limit).reverse();
  } catch {
    return []; // file not created yet
  }
}

export function errorLogSize(): number {
  try {
    return fs.statSync(ERROR_LOG_PATH).size;
  } catch {
    return 0;
  }
}

// Clear the log (admin action). Truncates rather than unlinks so the path/dir
// stay put for the next append.
export function clearErrorLog(): void {
  try {
    ensureDir();
    fs.writeFileSync(ERROR_LOG_PATH, "");
  } catch {
    // best-effort
  }
}

// Wire the funnel: from now on every createLogger().error() also persists here.
registerErrorSink(recordErrorEvent);

// Run a fire-and-forget async task without swallowing its rejection: a rejected
// promise reaches this catch, which routes through createLogger().error() and so
// into this log. Use for `void`-launched background work (extractions, notifies)
// that would otherwise vanish. The logger funnel is the primary capture path;
// this is the small wrapper the issue asks for on top of it.
export function runBackground(
  logger: { error: (msg: string, fields?: Record<string, unknown>) => void },
  label: string,
  fn: () => Promise<unknown>
): void {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      logger.error(`background task failed: ${label}`, { err });
    });
}
