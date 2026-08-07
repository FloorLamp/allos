// Persisted NOTIFICATION-TICK log (issue #2209). The THIRD sink behind the shared
// JSONL substrate (lib/jsonl-log-file.ts, #1883), alongside data/logs/errors.jsonl
// (#596) and data/logs/ai.jsonl.
//
// WHAT IT FIXES. `error` was the only durable level. Everything the tick says below
// it — "nothing due", "already sent today", "no channels configured for profile",
// every "… nudge skipped: no channel", every reconcile outcome — went to stdout
// only, and the deploy timer recreates the sidecar container tens of times a day, so
// its working retention is under an hour, permanently. A SEND leaves a row
// (notify_messages + a notify_last_* marker); a DECLINE leaves nothing, anywhere.
// That asymmetry is the whole defect: "the digest didn't arrive" was answerable only
// while the container that decided it still existed.
//
// SCOPE FILTER, NOT LEVEL FILTER. The admitted scopes are declared in
// lib/notify-log-format.ts. Persisting every `info` from the whole web app is a
// different and much larger decision; this keeps what the tick already says.
//
// COST. Synchronous by design, exactly as the error sink is (a tick line must not
// yield mid-decision), and BEST-EFFORT: every failure in here is swallowed, so a
// full disk or an unwritable mount can slow nothing and fail nothing in the tick.
// The append is one `appendFileSync` under the shared advisory lock; the trim only
// reads the file once it is already over budget.
//
// PHI. Identical posture to errors.jsonl: profile names, item names and finding text
// can appear in a tick line, so the message and the field bag both go through the
// SAME `redactSecrets`/`buildDetail` chokepoint before anything is written, and the
// viewer is admin-only (app/(app)/settings/notify-log).
//
// Server-only: uses node:fs. Registers itself as log.ts's SCOPE sink at import and
// is pulled onto the Node boot path from lib/db.ts, so it never reaches the Edge
// middleware or a client bundle.

import fs from "node:fs";
import path from "node:path";
import { registerScopeSink, type LogScopeEvent } from "./log";
import { getLogContext } from "./log-context";
import { buildDetail, capDetail, redactSecrets } from "./error-log-format";
import {
  appendJsonlLine,
  clearJsonlFile,
  type JsonlBudgets,
} from "./jsonl-log-file";
import {
  notifyLogAdmits,
  parseNotifyLine,
  type NotifyEvent,
} from "./notify-log-format";
import { currentTickSubject } from "./tick-cache";

export const NOTIFY_LOG_PATH = path.join(
  process.cwd(),
  "data",
  "logs",
  "notify.jsonl"
);

// Same 5 MB trigger as its two siblings, and the same dual budget (#1841): the kept
// tail must fit BOTH, because a pure line-count trim re-triggers on every append.
// keepLines is higher than errors.jsonl's 2000 because a tick line is short (~300
// bytes against an error's ~550), so the BYTE budget should be the binding one —
// which is what makes the retention statement ("a few hundred lines a day for a few
// weeks") come out of the file size rather than out of a line count nobody measured.
const MAX_BYTES = 5 * 1024 * 1024;
const BUDGETS: JsonlBudgets = {
  maxBytes: MAX_BYTES,
  keepLines: 8000,
  keepBytes: MAX_BYTES / 2,
};

// How much of the tail the admin viewer parses per render. The Errors page reads the
// WHOLE file and slices — correct for 73 rare events, wrong here, where a full file
// is ~15k lines and every render would parse all of them to show 25 rows. The window
// is generous enough to hold days of runs and bounded enough that a render is cheap;
// the page says plainly when it did not reach the start of the file.
export const NOTIFY_VIEW_BYTES = 1024 * 1024;

// ---- The run id --------------------------------------------------------------
//
// A RUN is one invocation of the tick, across every profile it fans out over. The
// viewer groups by (run, profile), and grouping honestly needs an id: bucketing by
// timestamp guesses wrong the moment a tick straddles a minute, which is the common
// case for a fan-out over several profiles.
//
// The id is minted ONCE per process by the tick and lives in a module slot: the tick
// process is the run. The PROFILE half comes from the open tick-cache scope, which
// scripts/notify.ts already opens one of per profile — that scope is what "which
// profile is being evaluated right now" already means.

let currentRunId: string | null = null;

// Mint (or re-declare) this process's run id. Called once by the tick entrypoint.
// Base-36 time plus a counter, so two ticks that start in the same millisecond on
// one box still separate.
let runSeq = 0;
export function beginNotifyRun(): string {
  runSeq = (runSeq + 1) % 1_000_000;
  currentRunId = `${Date.now().toString(36)}-${runSeq.toString(36)}`;
  return currentRunId;
}

export function currentNotifyRunId(): string | null {
  return currentRunId;
}

// Test seam: forget the run so a suite can assert the un-stamped path too.
export function endNotifyRun(): void {
  currentRunId = null;
}

// ---- The sink ----------------------------------------------------------------

let seq = 0;
function nextId(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now()}-${seq.toString().padStart(6, "0")}`;
}

// Re-entrancy guard, same reason as recordErrorEvent's: this function's own failure
// would otherwise be logged through the central logger, whose scope sink is this
// function.
let writing = false;

// Read the call site's DECLARED decision, when it made one. A declaration always
// beats the message-text classification in lib/notify-log-format.ts.
function declaredDecision(
  fields: Record<string, unknown> | undefined
): NotifyEvent["decision"] {
  const d = fields?.decision;
  return d === "declined" || d === "proceeded" ? d : undefined;
}

// WHICH PROFILE a line is about, in the order the answers are trustworthy:
//
//   1. the OPEN tick scope's declared subject — the tick is evaluating that profile
//      right now, and it cannot be wrong;
//   2. the line's own `profile` field, which the notify call sites already pass
//      (`log.info("nothing due", { profile: profileId })` and 60-odd siblings). This
//      is what attributes the tick's global phase, the manual sends and the poll
//      loop, none of which open a scope;
//   3. the ambient request context, for a `notify`-scoped line emitted inside a web
//      request (a Telegram tap through the webhook route).
//
// Nothing here INVENTS an attribution: with none of the three present the line is
// global, and the viewer groups it as the run's global row.
function subjectProfile(
  fields: Record<string, unknown> | undefined
): number | null {
  const scoped = currentTickSubject();
  if (scoped) return scoped.profileId;
  const declared = fields?.profile;
  if (typeof declared === "number" && Number.isInteger(declared))
    return declared;
  return getLogContext()?.profileId ?? null;
}

// Append one tick line. Best-effort — never throws into the tick's flow.
export function recordNotifyEvent(e: LogScopeEvent): void {
  if (!notifyLogAdmits(e)) return;
  if (writing) return;
  writing = true;
  try {
    const ctx = getLogContext();
    const event: NotifyEvent = {
      id: nextId(),
      time: new Date().toISOString(),
      level: e.level,
      scope: e.scope,
      runId: currentRunId,
      profileId: subjectProfile(e.fields),
      loginId: ctx?.loginId ?? null,
      message: capDetail(redactSecrets(e.msg), 1000),
      detail: buildDetail(e.fields),
      decision: declaredDecision(e.fields),
    };
    appendJsonlLine(NOTIFY_LOG_PATH, JSON.stringify(event) + "\n", BUDGETS);
  } catch {
    // Deliberately swallowed. A tick that cannot write its diary must still deliver
    // its medication reminders, and the raw line already reached stdout through the
    // console emit in log.ts. Re-logging here would only spin the guard above.
  } finally {
    writing = false;
  }
}

// ---- Reads -------------------------------------------------------------------

export function notifyLogSize(): number {
  try {
    return fs.statSync(NOTIFY_LOG_PATH).size;
  } catch {
    return 0;
  }
}

export interface NotifyLogRead {
  events: NotifyEvent[];
  // The read did not reach the start of the file — older runs exist on disk that
  // this window did not cover. The page says so rather than implying completeness.
  truncated: boolean;
  size: number;
}

// The newest NOTIFY_VIEW_BYTES of the log, parsed. A partial first line at the
// window boundary fails parseNotifyLine and is dropped, exactly as the AI log's tail
// read does.
export function readNotifyEvents(
  windowBytes = NOTIFY_VIEW_BYTES
): NotifyLogRead {
  const size = notifyLogSize();
  if (size === 0) return { events: [], truncated: false, size: 0 };
  const start = Math.max(0, size - windowBytes);
  try {
    const fd = fs.openSync(NOTIFY_LOG_PATH, "r");
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const events: NotifyEvent[] = [];
      for (const line of buf.toString("utf8").split("\n")) {
        const ev = parseNotifyLine(line);
        if (ev) events.push(ev);
      }
      return { events, truncated: start > 0, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], truncated: false, size };
  }
}

// Clear the log (admin action). Truncates rather than unlinks so the path and dir
// stay put for the next append; mirrors clearErrorLog()/clearAiLog().
export function clearNotifyLog(): void {
  try {
    clearJsonlFile(NOTIFY_LOG_PATH);
  } catch {
    // best-effort
  }
}

// Wire the funnel: from now on every admitted-scope line also persists here.
registerScopeSink(recordNotifyEvent);
