// DB INTEGRATION TIER — per-profile daily AI-usage cap (rate-limiting Fix 1).
//   1. checkAndIncrementAiUsage is an atomic read-increment: N calls at limit N all
//      pass with counts 1..N, the (N+1)th is denied and the stored count stays N.
//   2. The "extraction" and "insight" kinds are counted independently.
//   3. Counts are per-profile — a second profile has its own independent counter
//      (also exercises the profile_id scoping the static scan can't verify across
//      the transaction).
//   4. getAiUsageCount reflects the stored count without incrementing.
// The pure decision logic is covered separately in lib/__tests__/ai-usage.test.ts;
// this is the dynamic guard over the SQLite read-increment wrapper.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { checkAndIncrementAiUsage, getAiUsageCount } from "@/lib/ai-usage";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Fixed synthetic day so the test never depends on the profile's local clock.
const DAY = "2025-01-15";

let pa: number;
let pb: number;

beforeAll(() => {
  pa = newProfile("AIUSAGE-A");
  pb = newProfile("AIUSAGE-B");
});

describe("checkAndIncrementAiUsage — atomic read-increment", () => {
  it("allows exactly `limit` calls, then denies without over-counting", () => {
    const N = 3;
    for (let i = 1; i <= N; i++) {
      const res = checkAndIncrementAiUsage(pa, "extraction", N, DAY);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(N - i);
      expect(getAiUsageCount(pa, "extraction", DAY)).toBe(i);
    }
    // The (N+1)th call is denied and the stored count stays pinned at N.
    const denied = checkAndIncrementAiUsage(pa, "extraction", N, DAY);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(getAiUsageCount(pa, "extraction", DAY)).toBe(N);
  });

  it("counts the two kinds independently", () => {
    // profile A's "extraction" bucket is already at 3 from the prior test; its
    // "insight" bucket must be untouched.
    expect(getAiUsageCount(pa, "insight", DAY)).toBe(0);
    const res = checkAndIncrementAiUsage(pa, "insight", 5, DAY);
    expect(res.allowed).toBe(true);
    expect(getAiUsageCount(pa, "insight", DAY)).toBe(1);
    // Incrementing "insight" did not disturb "extraction".
    expect(getAiUsageCount(pa, "extraction", DAY)).toBe(3);
  });

  it("keeps counts per-profile (no cross-profile bleed)", () => {
    // profile B starts fresh even though A has burned its extraction quota.
    expect(getAiUsageCount(pb, "extraction", DAY)).toBe(0);
    const res = checkAndIncrementAiUsage(pb, "extraction", 3, DAY);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(2);
    expect(getAiUsageCount(pb, "extraction", DAY)).toBe(1);
    // A's exhausted counter is unchanged by B's increment.
    expect(getAiUsageCount(pa, "extraction", DAY)).toBe(3);
  });
});
