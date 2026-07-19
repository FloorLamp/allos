import { describe, expect, it } from "vitest";
import {
  hitRateLimit,
  pruneRateBuckets,
  type RateBucket,
} from "@/lib/auth-email-ratelimit";

describe("reset-request rate limiter (#985)", () => {
  it("allows up to the limit in a window, then blocks", () => {
    const map = new Map<string, RateBucket>();
    const now = 1_000_000;
    // limit 3, 1h window
    expect(hitRateLimit(map, "e", now, 3, 3600_000).allowed).toBe(true); // 1
    expect(hitRateLimit(map, "e", now, 3, 3600_000).allowed).toBe(true); // 2
    expect(hitRateLimit(map, "e", now, 3, 3600_000).allowed).toBe(true); // 3
    expect(hitRateLimit(map, "e", now, 3, 3600_000).allowed).toBe(false); // 4 — blocked
  });

  it("keys are independent", () => {
    const map = new Map<string, RateBucket>();
    const now = 5;
    expect(hitRateLimit(map, "a", now, 1, 1000).allowed).toBe(true);
    expect(hitRateLimit(map, "a", now, 1, 1000).allowed).toBe(false);
    // A different key has its own fresh budget.
    expect(hitRateLimit(map, "b", now, 1, 1000).allowed).toBe(true);
  });

  it("a fresh window after windowMs resets the count", () => {
    const map = new Map<string, RateBucket>();
    expect(hitRateLimit(map, "e", 0, 1, 1000).allowed).toBe(true);
    expect(hitRateLimit(map, "e", 500, 1, 1000).allowed).toBe(false); // same window
    expect(hitRateLimit(map, "e", 1000, 1, 1000).allowed).toBe(true); // window elapsed
  });

  it("pruneRateBuckets drops only elapsed buckets", () => {
    const map = new Map<string, RateBucket>();
    hitRateLimit(map, "old", 0, 5, 1000);
    hitRateLimit(map, "new", 900, 5, 1000);
    pruneRateBuckets(map, 1200, 1000); // "old" window elapsed (>=1000), "new" not
    expect(map.has("old")).toBe(false);
    expect(map.has("new")).toBe(true);
  });
});
