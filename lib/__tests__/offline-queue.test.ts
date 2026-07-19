import { describe, it, expect } from "vitest";
import {
  FLOW_KINDS,
  buildIntent,
  chunkIntents,
  MAX_INTENTS,
  newIdempotencyKey,
  localDate,
  isSettled,
  settledKeys,
  isAuthFailure,
  shouldQueueOffline,
  planFlushDisposition,
  describeIntent,
  MAX_REPLAY_ATTEMPTS,
  type QueuedIntent,
  type ReplayResult,
} from "@/lib/offline/queue";

// Pure decision logic for the offline write queue (issue #28). The IndexedDB glue
// (queue-db) and the server writes (writes.ts) are exercised by the e2e; this covers
// the DB-free core.

describe("newIdempotencyKey", () => {
  it("returns a uuid-shaped string, unique across calls", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(a).not.toBe(b);
  });
});

describe("buildIntent", () => {
  it("stamps a fresh key + capture timestamp + the capturing profile, and carries the payload/date", () => {
    const now = new Date("2026-02-03T14:30:00.000Z");
    const intent = buildIntent("dose", "2026-02-03", { doseId: 7 }, 5, now);
    expect(intent.flow).toBe("dose");
    expect(intent.date).toBe("2026-02-03");
    expect(intent.capturedAt).toBe("2026-02-03T14:30:00.000Z");
    expect(intent.payload).toEqual({ doseId: 7 });
    // The profile the write was captured under (issue #599) — replay attributes it here.
    expect(intent.profileId).toBe(5);
    expect(intent.key.length).toBeGreaterThan(0);
  });

  it("gives distinct keys to two intents built back-to-back", () => {
    const a = buildIntent(
      "vitals",
      "2026-01-01",
      {
        systolic: "120",
        diastolic: "80",
        glucose: null,
        glucoseUnit: null,
        spo2: null,
        temperature: null,
        tempUnit: null,
        sleepHours: null,
        hrv: null,
        gripStrength: null,
        chairStand: null,
        balance: null,
      },
      1
    );
    const b = buildIntent(
      "vitals",
      "2026-01-01",
      {
        systolic: "121",
        diastolic: "81",
        glucose: null,
        glucoseUnit: null,
        spo2: null,
        temperature: null,
        tempUnit: null,
        sleepHours: null,
        hrv: null,
        gripStrength: null,
        chairStand: null,
        balance: null,
      },
      1
    );
    expect(a.key).not.toBe(b.key);
  });
});

describe("chunkIntents (issue #604)", () => {
  it("splits N items into ceil(N/size) chunks, preserving order", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    expect(chunkIntents(items, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("returns a single chunk when the queue fits under the cap", () => {
    const items = [1, 2, 3];
    expect(chunkIntents(items, 200)).toEqual([[1, 2, 3]]);
  });

  it("returns no chunks for an empty queue", () => {
    expect(chunkIntents([], 200)).toEqual([]);
  });

  it("makes exactly ceil(201/200)=2 chunks at the 200-cap boundary", () => {
    const items = Array.from({ length: 201 }, (_, i) => i);
    const chunks = chunkIntents(items, MAX_INTENTS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_INTENTS);
    expect(chunks[1]).toHaveLength(1);
    // Order + completeness preserved across the split.
    expect(chunks.flat()).toEqual(items);
  });

  it("defaults the chunk size to the shared MAX_INTENTS cap", () => {
    const items = Array.from({ length: MAX_INTENTS + 1 }, (_, i) => i);
    expect(chunkIntents(items)).toHaveLength(2);
  });

  it("rejects a non-positive size (a zero/negative would loop forever)", () => {
    expect(() => chunkIntents([1, 2], 0)).toThrow();
    expect(() => chunkIntents([1, 2], -1)).toThrow();
  });
});

describe("localDate", () => {
  it("formats a local Date as YYYY-MM-DD (zero-padded)", () => {
    expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isSettled / settledKeys", () => {
  it("treats done/duplicate/rejected as settled and error as retryable", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("duplicate")).toBe(true);
    expect(isSettled("rejected")).toBe(true);
    expect(isSettled("error")).toBe(false);
  });

  it("returns only the keys of settled results (errors stay queued)", () => {
    const results: ReplayResult[] = [
      { key: "a", status: "done" },
      { key: "b", status: "error" },
      { key: "c", status: "duplicate" },
      { key: "d", status: "rejected" },
    ];
    expect(settledKeys(results).sort()).toEqual(["a", "c", "d"]);
  });
});

describe("isAuthFailure", () => {
  it("is true only for 401/403", () => {
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(403)).toBe(true);
    expect(isAuthFailure(200)).toBe(false);
    expect(isAuthFailure(500)).toBe(false);
    expect(isAuthFailure(400)).toBe(false);
  });
});

describe("shouldQueueOffline", () => {
  it("queues whenever the browser reports offline, regardless of error", () => {
    expect(shouldQueueOffline(false, new Error("x"))).toBe(true);
    expect(shouldQueueOffline(false, undefined)).toBe(true);
  });

  it("queues a network TypeError even when navigator claims online", () => {
    expect(shouldQueueOffline(true, new TypeError("Failed to fetch"))).toBe(
      true
    );
  });

  it("does NOT queue a genuine server-side error while online", () => {
    expect(shouldQueueOffline(true, new Error("validation failed"))).toBe(
      false
    );
    expect(shouldQueueOffline(true, undefined)).toBe(false);
  });
});

describe("FLOW_KINDS", () => {
  it("is exactly the queueable quick-log flows", () => {
    expect([...FLOW_KINDS]).toEqual([
      "dose",
      "skip-dose",
      "body-metric",
      "vitals",
      // Daily mood check-in (#992): idempotent per profile+date on the server's
      // UNIQUE(profile_id, date) upsert.
      "mood",
    ]);
  });
});

describe("planFlushDisposition (issue #475)", () => {
  const now = new Date("2026-07-12T10:00:00.000Z");
  function intent(key: string, attempts = 0): QueuedIntent {
    return {
      key,
      flow: "dose",
      date: "2026-07-10",
      capturedAt: "2026-07-10T09:00:00.000Z",
      payload: { doseId: 1 },
      attempts,
    };
  }

  it("deletes + counts done/duplicate as synced, and never parks them", () => {
    const intents = [intent("a"), intent("b")];
    const results: ReplayResult[] = [
      { key: "a", status: "done" },
      { key: "b", status: "duplicate" },
    ];
    const plan = planFlushDisposition(intents, results, now);
    expect(plan.syncedCount).toBe(2);
    expect(plan.deleteKeys.sort()).toEqual(["a", "b"]);
    expect(plan.rejected).toEqual([]);
    expect(plan.retry).toEqual([]);
  });

  it("parks a server-rejected intent (with its payload + reason) and deletes it from the live queue — never silently discarded", () => {
    const intents = [intent("a")];
    const results: ReplayResult[] = [
      { key: "a", status: "rejected", reason: "bad value" },
    ];
    const plan = planFlushDisposition(intents, results, now);
    expect(plan.deleteKeys).toEqual(["a"]);
    expect(plan.syncedCount).toBe(0);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].intent.key).toBe("a");
    expect(plan.rejected[0].intent.payload).toEqual({ doseId: 1 });
    expect(plan.rejected[0].reason).toBe("bad value");
    expect(plan.rejected[0].rejectedAt).toBe(now.toISOString());
  });

  it("falls back to a default reason when the server sends none", () => {
    const plan = planFlushDisposition(
      [intent("a")],
      [{ key: "a", status: "rejected" }],
      now
    );
    expect(plan.rejected[0].reason.length).toBeGreaterThan(0);
  });

  it("re-queues a transient error with a bumped attempt count, under the cap", () => {
    const plan = planFlushDisposition(
      [intent("a", 1)],
      [{ key: "a", status: "error" }],
      now
    );
    expect(plan.retry).toHaveLength(1);
    expect(plan.retry[0].attempts).toBe(2);
    expect(plan.deleteKeys).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it("reclassifies a permanently-erroring intent to rejected once it hits the cap (issue #475 point 3)", () => {
    const plan = planFlushDisposition(
      [intent("a", MAX_REPLAY_ATTEMPTS - 1)],
      [{ key: "a", status: "error" }],
      now
    );
    expect(plan.retry).toEqual([]);
    expect(plan.deleteKeys).toEqual(["a"]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].intent.attempts).toBe(MAX_REPLAY_ATTEMPTS);
    expect(plan.rejected[0].reason).toMatch(/attempts/);
  });

  it("ignores a result whose key is no longer in the live queue (fail-safe)", () => {
    const plan = planFlushDisposition(
      [intent("a")],
      [{ key: "ghost", status: "error" }],
      now
    );
    expect(plan.retry).toEqual([]);
    expect(plan.rejected).toEqual([]);
    // a shapeless rejected with no live row records the delete but parks nothing
    const plan2 = planFlushDisposition(
      [],
      [{ key: "ghost", status: "rejected" }],
      now
    );
    expect(plan2.deleteKeys).toEqual(["ghost"]);
    expect(plan2.rejected).toEqual([]);
  });
});

describe("describeIntent (issue #475)", () => {
  it("names the flow + captured date so the user can recognise a dropped entry", () => {
    const i = buildIntent(
      "body-metric",
      "2026-07-10",
      {
        weight: "80",
        weightUnit: "kg",
        bodyFatPct: null,
        restingHr: null,
        notes: null,
      },
      1
    );
    expect(describeIntent(i)).toBe("Body metric · 2026-07-10");
  });
});
