// Pure, in-process rate-limit counters (issue #985) for the password-reset REQUEST
// endpoint. Family scale: a fixed-window counter over a caller-supplied Map is
// plenty — no Redis, no DB. Kept pure (the Map + clock are injected) so the window
// / limit behavior is unit-tested without any request. The action module owns the
// long-lived Maps and keys them per-email and per-IP.

export interface RateBucket {
  count: number;
  // Epoch ms when the current window opened; the window is [windowStart, +windowMs).
  windowStart: number;
}

// Record one hit against `key` and report whether it is allowed. A fixed window:
// the first hit (or the first after the window elapsed) opens a fresh window with
// count 1; subsequent hits within the window increment. `allowed` is false once the
// count EXCEEDS `limit` in the current window. Mutates `map` in place.
export function hitRateLimit(
  map: Map<string, RateBucket>,
  key: string,
  nowMs: number,
  limit: number,
  windowMs: number
): { allowed: boolean } {
  const bucket = map.get(key);
  if (!bucket || nowMs - bucket.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: nowMs });
    return { allowed: 1 <= limit };
  }
  bucket.count += 1;
  return { allowed: bucket.count <= limit };
}

// Opportunistically drop stale buckets so the Maps can't grow without bound under a
// spray of distinct keys (many emails/IPs). Called from the action before a hit.
export function pruneRateBuckets(
  map: Map<string, RateBucket>,
  nowMs: number,
  windowMs: number
): void {
  for (const [key, bucket] of map) {
    if (nowMs - bucket.windowStart >= windowMs) map.delete(key);
  }
}

// Reset-request budgets (fixed 1-hour window). Per-email is tight (a real user needs
// one or two links); per-IP is a looser spray backstop for a shared NAT.
export const RESET_WINDOW_MS = 60 * 60 * 1000;
export const RESET_PER_EMAIL_LIMIT = 5;
export const RESET_PER_IP_LIMIT = 20;
