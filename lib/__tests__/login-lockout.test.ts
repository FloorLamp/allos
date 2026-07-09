import { describe, it, expect } from "vitest";
import {
  evaluateLockout,
  USERNAME_LOCKOUT,
  GLOBAL_LOCKOUT,
  type LockoutPolicy,
} from "../login-lockout";

// A small, easy-to-reason-about policy: 3 failures, 1s base, 8s ceiling.
const P: LockoutPolicy = {
  windowMs: 60_000,
  threshold: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

describe("evaluateLockout", () => {
  it("allows attempts below the threshold", () => {
    for (let n = 0; n < P.threshold; n++) {
      expect(
        evaluateLockout({ recentFailures: n, msSinceLastFailure: 0 }, P)
      ).toEqual({ lockedOut: false, retryAfterMs: 0 });
    }
  });

  it("locks out at the threshold with the base delay", () => {
    const d = evaluateLockout({ recentFailures: 3, msSinceLastFailure: 0 }, P);
    expect(d.lockedOut).toBe(true);
    expect(d.retryAfterMs).toBe(1_000);
  });

  it("doubles the backoff for each failure beyond the threshold", () => {
    // over = failures - threshold; delay = base * 2**over.
    expect(
      evaluateLockout({ recentFailures: 4, msSinceLastFailure: 0 }, P)
        .retryAfterMs
    ).toBe(2_000);
    expect(
      evaluateLockout({ recentFailures: 5, msSinceLastFailure: 0 }, P)
        .retryAfterMs
    ).toBe(4_000);
    expect(
      evaluateLockout({ recentFailures: 6, msSinceLastFailure: 0 }, P)
        .retryAfterMs
    ).toBe(8_000);
  });

  it("caps the backoff at maxDelayMs even for a large excess", () => {
    const d = evaluateLockout(
      { recentFailures: 3 + 40, msSinceLastFailure: 0 },
      P
    );
    // 2 ** 40 * base overflows well past the cap; must clamp, not go Infinity.
    expect(d.retryAfterMs).toBe(P.maxDelayMs);
    expect(Number.isFinite(d.retryAfterMs)).toBe(true);
  });

  it("lifts the lock once enough time has passed since the last failure", () => {
    // At the threshold the required wait is 1s; 1s elapsed → allowed again.
    expect(
      evaluateLockout({ recentFailures: 3, msSinceLastFailure: 1_000 }, P)
    ).toEqual({ lockedOut: false, retryAfterMs: 0 });
    // A bit more than the delay is likewise fine.
    expect(
      evaluateLockout({ recentFailures: 3, msSinceLastFailure: 5_000 }, P)
        .lockedOut
    ).toBe(false);
  });

  it("returns the remaining time when partway through the backoff", () => {
    const d = evaluateLockout(
      { recentFailures: 4, msSinceLastFailure: 500 },
      P
    );
    // required 2s, 0.5s elapsed → 1.5s left.
    expect(d).toEqual({ lockedOut: true, retryAfterMs: 1_500 });
  });

  it("never reports a negative retry time", () => {
    const d = evaluateLockout(
      { recentFailures: 3, msSinceLastFailure: 10_000 },
      P
    );
    expect(d.retryAfterMs).toBe(0);
  });

  it("treats no prior failures as never locked out", () => {
    expect(
      evaluateLockout({ recentFailures: 0, msSinceLastFailure: Infinity }, P)
    ).toEqual({ lockedOut: false, retryAfterMs: 0 });
  });

  it("ships sane shipped policies (username stricter than global)", () => {
    expect(USERNAME_LOCKOUT.threshold).toBeLessThan(GLOBAL_LOCKOUT.threshold);
    for (const p of [USERNAME_LOCKOUT, GLOBAL_LOCKOUT]) {
      expect(p.baseDelayMs).toBeLessThanOrEqual(p.maxDelayMs);
      expect(p.threshold).toBeGreaterThan(0);
      expect(p.windowMs).toBeGreaterThan(0);
    }
  });
});
