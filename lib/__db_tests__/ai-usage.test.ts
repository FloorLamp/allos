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
import {
  checkAndIncrementAiUsage,
  getAiUsageCount,
  refundAiUsage,
} from "@/lib/ai-usage";

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

describe("refundAiUsage — transactional decrement (issue #135 item 3)", () => {
  const RDAY = "2025-02-20";

  it("hands back exactly one unit and frees a slot under the cap", () => {
    const pc = newProfile("AIUSAGE-REFUND");
    // Burn the whole 3/day extraction cap.
    for (let i = 0; i < 3; i++) {
      checkAndIncrementAiUsage(pc, "extraction", 3, RDAY);
    }
    expect(getAiUsageCount(pc, "extraction", RDAY)).toBe(3);
    expect(checkAndIncrementAiUsage(pc, "extraction", 3, RDAY).allowed).toBe(
      false
    );

    // A transient failure refunds one unit; a fresh call now fits again.
    refundAiUsage(pc, "extraction", RDAY);
    expect(getAiUsageCount(pc, "extraction", RDAY)).toBe(2);
    const after = checkAndIncrementAiUsage(pc, "extraction", 3, RDAY);
    expect(after.allowed).toBe(true);
    expect(getAiUsageCount(pc, "extraction", RDAY)).toBe(3);
  });

  it("never goes below zero and no-ops when no counter row exists", () => {
    const pd = newProfile("AIUSAGE-REFUND-FLOOR");
    // No row yet — refund must be a harmless no-op (not create a negative row).
    refundAiUsage(pd, "extraction", RDAY);
    expect(getAiUsageCount(pd, "extraction", RDAY)).toBe(0);
    // One charge, two refunds → floored at 0, never negative.
    checkAndIncrementAiUsage(pd, "extraction", 5, RDAY);
    refundAiUsage(pd, "extraction", RDAY);
    refundAiUsage(pd, "extraction", RDAY);
    expect(getAiUsageCount(pd, "extraction", RDAY)).toBe(0);
  });

  it("only touches the named (profile, day, kind) counter", () => {
    const pe = newProfile("AIUSAGE-REFUND-SCOPE");
    checkAndIncrementAiUsage(pe, "extraction", 5, RDAY);
    checkAndIncrementAiUsage(pe, "insight", 5, RDAY);
    refundAiUsage(pe, "extraction", RDAY);
    expect(getAiUsageCount(pe, "extraction", RDAY)).toBe(0);
    // The insight bucket (different kind) is untouched by the extraction refund.
    expect(getAiUsageCount(pe, "insight", RDAY)).toBe(1);
  });
});
