// In-process concurrency limiter for AI extraction (rate-limiting Fix 1, part C).
// The medical-upload path dispatches document extraction fire-and-forget, so a
// user uploading several files quickly can fan out many simultaneous Claude calls.
// This bounds how many extractions run at once (the rest QUEUE and start as slots
// free), smoothing the burst instead of hammering the API in parallel.
//
// This module imports NOTHING (no DB, no network): it is pure queue/permit logic
// so it can be unit-tested directly (lib/__tests__/ai-concurrency.test.ts). The
// limit is per Node process — fine for this single-container deploy; a
// multi-instance deploy would need a shared limiter, which is out of scope here.

// Thrown by acquire()/run() when the wait queue is full (issue #135, item 2). A
// distinct class so a caller can tell "the queue is saturated, shed this task"
// apart from a real task failure and degrade gracefully (mark the doc 'skipped').
export class QueueFullError extends Error {
  constructor(maxWaiters: number) {
    super(`Extraction queue is full (max ${maxWaiters} waiting).`);
    this.name = "QueueFullError";
  }
}

// A classic counting semaphore. `run()` is the ergonomic wrapper most callers
// want: it acquires a permit, runs the async task, and releases the permit even if
// the task throws — so a rejected extraction can never leak a permit and wedge the
// queue.
export class Semaphore {
  private readonly max: number;
  // Free permits available right now. A waiter is handed a permit DIRECTLY on
  // release (the count is not bumped back up), so `permits` never transiently
  // over-counts while waiters are pending.
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  // Hard cap on how many callers may PARK waiting for a permit (issue #135, item
  // 2). Infinity = unbounded (the historical behavior). A finite cap bounds the
  // memory the queue can pin: acquire() past the cap rejects with QueueFullError
  // instead of parking another waiter, so a burst of uploads sheds load rather than
  // growing the queue without limit.
  private readonly maxWaiters: number;

  constructor(max: number, maxWaiters: number = Infinity) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("Semaphore size must be a positive integer");
    }
    if (
      maxWaiters !== Infinity &&
      (!Number.isInteger(maxWaiters) || maxWaiters < 0)
    ) {
      throw new Error(
        "Semaphore maxWaiters must be a non-negative integer or Infinity"
      );
    }
    this.max = max;
    this.permits = max;
    this.maxWaiters = maxWaiters;
  }

  // Acquire a permit, waiting (FIFO) until one is free. Resolves once the caller
  // holds a permit; the caller MUST call release() exactly once afterward (or use
  // run(), which does it for you). Rejects with QueueFullError WITHOUT parking when
  // the wait queue is already at maxWaiters — no permit is taken, so nothing needs
  // releasing on that rejection.
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(new QueueFullError(this.maxWaiters));
    }
    return new Promise<void>((resolve) => {
      // The permit is handed to us directly on release() — we do NOT decrement
      // `permits` here (it is already 0 while anyone is waiting).
      this.waiters.push(resolve);
    });
  }

  // Release a held permit. If anyone is waiting, hand the permit straight to the
  // next waiter (FIFO); otherwise return it to the free pool (capped at max, so a
  // stray double-release can't inflate capacity).
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits = Math.min(this.max, this.permits + 1);
  }

  // Acquire → run → release (even on throw). Returns the task's result/rejection.
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  // Introspection (used by tests and diagnostics).
  get maxConcurrency(): number {
    return this.max;
  }
  // Permits currently held (in flight). While waiters are pending this equals max.
  get inUse(): number {
    return this.max - this.permits;
  }
  // Free permits right now.
  get available(): number {
    return this.permits;
  }
  // Callers parked waiting for a permit.
  get waiting(): number {
    return this.waiters.length;
  }
  // The configured wait-queue cap (Infinity when unbounded).
  get maxQueue(): number {
    return this.maxWaiters;
  }
}

// Max concurrent document extractions per process. Overridable per deploy via env;
// the default stays the source of truth in code.
export const DEFAULT_EXTRACTION_CONCURRENCY = 3;

// Max uploads that may QUEUE behind the running extractions before the limiter
// sheds load (issue #135, item 2). Generous — well past any realistic interactive
// burst — because the queued closures no longer pin document buffers (the job
// re-reads the stored file from disk when its slot frees), so the cap is a
// backstop against pathological floods, not a routine limit.
export const DEFAULT_EXTRACTION_QUEUE_MAX = 100;

function envConcurrency(fallback: number): number {
  const raw = process.env.AI_EXTRACTION_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function envQueueMax(fallback: number): number {
  const raw = process.env.AI_EXTRACTION_QUEUE_MAX;
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Process-wide semaphore the medical-upload/reprocess paths route extraction
// dispatch through, so at most N run at once and the rest queue (up to the queue
// cap, past which a fresh dispatch is shed rather than parked).
export const extractionSemaphore = new Semaphore(
  envConcurrency(DEFAULT_EXTRACTION_CONCURRENCY),
  envQueueMax(DEFAULT_EXTRACTION_QUEUE_MAX)
);
