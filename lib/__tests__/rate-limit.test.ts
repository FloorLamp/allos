import { describe, it, expect } from "vitest";
import {
  decideRateLimit,
  checkRateLimit,
  forwardedClientIdentity,
} from "@/lib/rate-limit";

describe("decideRateLimit", () => {
  const limit = 3;
  const windowMs = 60_000;

  it("allows the first request and opens a fresh window", () => {
    const d = decideRateLimit(undefined, 1_000, limit, windowMs);
    expect(d.ok).toBe(true);
    expect(d.retryAfterSec).toBe(0);
    expect(d.state).toEqual({ count: 1, resetAt: 1_000 + windowMs });
  });

  it("allows requests up to the limit, then rejects within the window", () => {
    const now = 1_000;
    // count 1 -> 2 (allowed)
    const s1 = { count: 1, resetAt: now + windowMs };
    const d2 = decideRateLimit(s1, now, limit, windowMs);
    expect(d2.ok).toBe(true);
    expect(d2.state.count).toBe(2);

    // count 2 -> 3 (allowed, reaches limit)
    const d3 = decideRateLimit(d2.state, now, limit, windowMs);
    expect(d3.ok).toBe(true);
    expect(d3.state.count).toBe(3);

    // count already at limit -> rejected, count not advanced
    const later = now + 20_000; // 40s until reset
    const d4 = decideRateLimit(d3.state, later, limit, windowMs);
    expect(d4.ok).toBe(false);
    expect(d4.state.count).toBe(3); // unchanged
    expect(d4.retryAfterSec).toBe(40); // ceil((resetAt - now)/1000)
  });

  it("starts a new window once the previous one has expired", () => {
    const state = { count: 3, resetAt: 60_000 };
    const d = decideRateLimit(state, 60_000, limit, windowMs); // now === resetAt
    expect(d.ok).toBe(true);
    expect(d.state).toEqual({ count: 1, resetAt: 60_000 + windowMs });

    const past = decideRateLimit(state, 999_999, limit, windowMs);
    expect(past.ok).toBe(true);
    expect(past.state.count).toBe(1);
  });

  it("reports a minimum retryAfter of 1 second", () => {
    const state = { count: 3, resetAt: 1_500 };
    const d = decideRateLimit(state, 1_499, limit, windowMs); // 1ms left
    expect(d.ok).toBe(false);
    expect(d.retryAfterSec).toBe(1);
  });
});

describe("checkRateLimit", () => {
  it("allows a first request then rejects once the budget is spent", () => {
    const key = `test-key-${Math.random()}`;
    const opts = { limit: 2, windowMs: 60_000 };
    expect(checkRateLimit(key, opts).ok).toBe(true);
    expect(checkRateLimit(key, opts).ok).toBe(true);
    const rejected = checkRateLimit(key, opts);
    expect(rejected.ok).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThan(0);
  });

  it("keeps independent keys from interfering", () => {
    const a = `key-a-${Math.random()}`;
    const b = `key-b-${Math.random()}`;
    const opts = { limit: 1, windowMs: 60_000 };
    expect(checkRateLimit(a, opts).ok).toBe(true);
    expect(checkRateLimit(a, opts).ok).toBe(false); // a exhausted
    expect(checkRateLimit(b, opts).ok).toBe(true); // b still fresh
  });
});

describe("forwardedClientIdentity", () => {
  it("trusts the RIGHTMOST XFF hop when behind a proxy", () => {
    // Proxies append the real client on the right; leftmost entries are
    // attacker-supplied, so the rightmost is what the trusted proxy observed.
    expect(forwardedClientIdentity("1.2.3.4, 5.6.7.8, 9.9.9.9", true)).toBe(
      "9.9.9.9"
    );
    expect(forwardedClientIdentity("203.0.113.7", true)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' behind a proxy with no/blank XFF", () => {
    expect(forwardedClientIdentity(null, true)).toBe("unknown");
    expect(forwardedClientIdentity("", true)).toBe("unknown");
    expect(forwardedClientIdentity("  ,  ", true)).toBe("unknown");
  });

  it("collapses everything to one 'direct' bucket when no proxy is trusted", () => {
    // Without a trusted proxy XFF is fully spoofable, so distinct forged values
    // must NOT mint distinct buckets — they all share the single 'direct' key.
    expect(forwardedClientIdentity("1.1.1.1", false)).toBe("direct");
    expect(forwardedClientIdentity("2.2.2.2", false)).toBe("direct");
    expect(forwardedClientIdentity(null, false)).toBe("direct");
  });
});
