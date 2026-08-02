// The fs half of the append-only JSONL logs (issue #1883), shared by both sinks
// (lib/ai-log.ts, lib/error-log.ts). The pure trim ALGORITHM lives next door in
// lib/jsonl-trim.ts; this module owns the file I/O around it so the two sinks
// cannot drift apart on durability the way they drifted on trimming.
//
// WHY THIS EXISTS — THE MULTI-PROCESS REALITY. `docker-compose.yml` runs the
// `allos-notify` sidecar as a SEPARATE OS PROCESS on the SAME `DATA_DIR` bind
// mount as the web app: an hourly tick plus a long-running Telegram getUpdates
// poller, both of which call `createLogger("notify")` and so append to the same
// `data/logs/errors.jsonl` the web app trims. A host crontab `npm run notify`
// during the hourly one, or two app instances on one volume, is the same shape —
// exactly the posture lib/notifications/message-pointers.ts already documents for
// the pointer table. The old trim was a bare readFileSync → writeFileSync, so an
// append landing between the read and the write was silently overwritten (in
// EITHER direction: the app could eat the sidecar's line and vice versa).
//
// THE INVARIANT. An append that COMPLETED before a trim's read survives that
// trim, and no reader ever observes a truncated or half-written file. Two
// mechanisms, both needed:
//
//   1. An advisory cross-process lock (O_CREAT|O_EXCL lockfile — atomic on POSIX
//      and on the volume both containers share) held across the WHOLE
//      append-then-maybe-trim sequence. Writers therefore serialize: a completed
//      append is by construction already in the file when the next trim reads it.
//      The lock is what makes the invariant a guarantee, and it only holds for
//      writers that come through this module — which is the point of putting the
//      only two writers behind one chokepoint.
//   2. A temp-file + `fs.renameSync` swap. POSIX rename is atomic, so a reader
//      (the admin Errors table, the AI log SSE tail) sees either the whole old
//      file or the whole new one, never a partially rewritten one. The rename
//      also bounds the damage from any NON-cooperating writer: before swapping we
//      re-check the original's size and carry over anything appended since our
//      snapshot, so a raw `appendFileSync` from outside this module is rescued
//      too, right up to the rename itself.
//
// Best-effort throughout: logging must never throw into the caller's flow, and a
// lock we cannot take degrades to "append anyway, skip the trim" — losing a trim
// is harmless (the next append retries it), losing an event is not.

import fs from "node:fs";
import path from "node:path";
import { trimJsonlLines } from "./jsonl-trim";

export interface JsonlBudgets {
  // Rewrite once the file grows past this many bytes.
  maxBytes: number;
  // The kept tail must fit BOTH budgets (see lib/jsonl-trim.ts).
  keepLines: number;
  keepBytes: number;
}

// Lock tuning. A trim rewrites at most a few MB, so the holder is measured in
// milliseconds; the wait budget is generous enough to ride out a contended trim
// and short enough that a wedged holder can't stall an error append. A lockfile
// older than STALE_MS belonged to a process that died mid-trim (SIGKILL, OOM,
// container stop) — break it rather than wait forever.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 5;

// Synchronous sleep. These sinks are synchronous by design (an error append must
// not yield the request path mid-report), so the poll can't await; Atomics.wait
// is the supported main-thread sync sleep in Node.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

// Try to take the advisory lock. Returns false when the wait budget runs out.
function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      // "wx" = O_CREAT|O_EXCL: succeeds for exactly one racer, across processes.
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return true;
    } catch {
      // Held by someone else (or unwritable). Break it if it's stale, else wait.
      let ageMs: number | null = null;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        ageMs = null; // vanished between our open and stat, or unreadable
      }
      if (ageMs !== null && ageMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // someone else broke it first; fall through and retry
        }
      }
      // Deadline is checked on EVERY failure, whatever the cause, so a lock dir
      // we simply can't write to can't spin here forever.
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone (stale-broken by someone else) — nothing to undo
  }
}

// Run `fn` under the file's advisory lock. `fn` receives whether the lock was
// actually taken so a caller can decide what is safe to do without it.
function withFileLock<T>(filePath: string, fn: (locked: boolean) => T): T {
  const lockPath = lockPathFor(filePath);
  const locked = acquireLock(lockPath);
  try {
    return fn(locked);
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// Read the whole file and report the byte offset that snapshot ended at, so the
// pre-rename catch-up below knows exactly what it has already seen.
function readSnapshot(filePath: string): { text: string; size: number } {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return { text: buf.toString("utf8"), size };
  } finally {
    fs.closeSync(fd);
  }
}

function readRange(filePath: string, from: number, to: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const len = to - from;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// How many times to re-check for late appends before swapping. One round is
// enough for cooperating writers (the lock excludes them entirely); the extra
// rounds only narrow the window for a writer that bypassed this module.
const CATCHUP_ROUNDS = 3;

// Rewrite the file down to its budgeted tail, atomically. Call under the lock.
function trimLocked(filePath: string, budgets: JsonlBudgets): void {
  const { size } = fs.statSync(filePath);
  // Cheap byte check first; only read the whole file once the byte budget is
  // already blown (avoids reading it on every append).
  if (size <= budgets.maxBytes) return;

  const snapshot = readSnapshot(filePath);
  const kept = trimJsonlLines(
    snapshot.text.split("\n"),
    budgets.keepLines,
    budgets.keepBytes
  );
  const tmpPath = `${filePath}.trim-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
    // Carry over anything appended since the snapshot. Cooperating writers are
    // locked out, so this only ever fires for an outside appender — but when it
    // does, the rename would otherwise drop those bytes on the floor.
    let seen = snapshot.size;
    for (let i = 0; i < CATCHUP_ROUNDS; i++) {
      const now = fs.statSync(filePath).size;
      if (now <= seen) break;
      fs.appendFileSync(tmpPath, readRange(filePath, seen, now));
      seen = now;
    }
    // Atomic swap: a concurrent reader sees the old file or the new one.
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // never created, or already renamed into place
    }
    throw err;
  }
}

// Append one already-serialized line (caller supplies the trailing newline) and
// trim the file back to budget when it has outgrown `maxBytes`. Best-effort: the
// caller's own try/catch decides what a total fs failure means for its flow.
export function appendJsonlLine(
  filePath: string,
  line: string,
  budgets: JsonlBudgets
): void {
  ensureDir(filePath);
  withFileLock(filePath, (locked) => {
    fs.appendFileSync(filePath, line);
    // Without the lock the read-modify-write is exactly the race this module
    // exists to close, so skip it: the file stays over budget until an append
    // that DOES get the lock trims it.
    if (locked) trimLocked(filePath, budgets);
  });
}

// Truncate the file (the admin "Clear" action). Under the same lock as appends
// and trims so a clear can't be resurrected by a trim's rename landing after it.
export function clearJsonlFile(filePath: string): void {
  ensureDir(filePath);
  withFileLock(filePath, () => {
    fs.writeFileSync(filePath, "");
  });
}
