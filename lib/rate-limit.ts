// Small in-process fixed-window rate limiter for the public / token-authenticated
// routes (Health Connect ingest, calendar feed, share view, Telegram webhook).
// These handlers run in the Node runtime, so a module-level Map is shared across
// requests within a single server process. This is intentionally NOT a global,
// cross-instance limiter (that would need Redis/DB); it's a cheap DoS/cost guard
// against a single client hammering one process. Edge middleware can't use it —
// it can't open SQLite or share this Map — so limiting is applied per-route in
// the Node handlers.
//
// The core decision is the pure `decideRateLimit()`; `checkRateLimit()` wraps it
// over a module-level Map (and `Date.now()`, which is allowed in app-runtime code
// — only workflow scripts forbid it).

export interface RateLimitState {
  count: number;
  resetAt: number; // epoch ms when the current window ends
}

export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec: number; // seconds until the window resets (0 when allowed)
  state: RateLimitState; // the state to store back for this key
}

// Pure fixed-window decision: given the currently-stored state for a key (or
// undefined), the current time, and the window budget, return whether the request
// is allowed and the next state to persist. A fresh or expired window starts a new
// window at count 1; within an active window each allowed request increments the
// count; once the count reaches `limit` further requests are rejected without
// advancing the count, and report the whole-seconds wait until reset.
export function decideRateLimit(
  existing: RateLimitState | undefined,
  now: number,
  limit: number,
  windowMs: number
): RateLimitDecision {
  if (!existing || now >= existing.resetAt) {
    return {
      ok: true,
      retryAfterSec: 0,
      state: { count: 1, resetAt: now + windowMs },
    };
  }
  if (existing.count < limit) {
    return {
      ok: true,
      retryAfterSec: 0,
      state: { count: existing.count + 1, resetAt: existing.resetAt },
    };
  }
  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return { ok: false, retryAfterSec, state: existing };
}

// Resolve the rate-limit identity for a shared-secret endpoint (e.g. the Telegram
// webhook) from its X-Forwarded-For header. XFF is client-controlled and only
// trustworthy behind a reverse proxy that APPENDS the real client, so the RIGHTMOST
// entry is the address that proxy actually observed. When NO trusted proxy is
// configured (`trustProxy` false), the header is fully spoofable — a caller could
// mint unlimited distinct buckets and defeat the throttle — so every request shares
// ONE bucket ("direct") instead, which still caps total throughput per process. A
// safe DoS guard when the client can't be attributed (issue #390). Pure so the
// policy is unit-testable without a Request/env.
export function forwardedClientIdentity(
  xffHeader: string | null,
  trustProxy: boolean
): string {
  if (!trustProxy) return "direct";
  const rightmost = (xffHeader ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return rightmost ?? "unknown";
}

const store = new Map<string, RateLimitState>();

// Lazy, amortized eviction: sweep expired entries at most once per sweep interval.
// Between sweeps a flood of DISTINCT keys (some keys derive from unauthenticated,
// pre-resolution input — calendar/share tokens, webhook client IPs — so an
// attacker can mint unlimited distinct keys) would otherwise grow the Map, so a
// hard size cap (`MAX_ENTRIES`) bounds it independently of the timed sweep.
const SWEEP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 10_000;
let lastSweep = 0;

function sweepExpired(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, state] of store) {
    if (now >= state.resetAt) store.delete(key);
  }
}

// Hard bound against a distinct-key flood outrunning the timed sweep: once the Map
// is at the cap, drop expired entries first; if still at the cap (many live keys),
// clear it entirely. Clearing just resets counters — a fixed window is cheap to
// rebuild and legitimate callers simply start a fresh window.
function enforceSizeCap(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [key, state] of store) {
    if (now >= state.resetAt) store.delete(key);
  }
  if (store.size >= MAX_ENTRIES) store.clear();
}

// Record one request against `key` and decide whether it's within the per-window
// budget. Returns `ok: false` with `retryAfterSec` (for a `Retry-After` header)
// when the window budget is exceeded.
export function checkRateLimit(
  key: string,
  opts: { limit: number; windowMs: number }
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweepExpired(now);
  enforceSizeCap(now);
  const decision = decideRateLimit(
    store.get(key),
    now,
    opts.limit,
    opts.windowMs
  );
  store.set(key, decision.state);
  return { ok: decision.ok, retryAfterSec: decision.retryAfterSec };
}
