import { describe, it, expect } from "vitest";
import {
  FLOW_KINDS,
  buildIntent,
  newIdempotencyKey,
  localDate,
  isSettled,
  settledKeys,
  isAuthFailure,
  shouldQueueOffline,
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
  it("stamps a fresh key + capture timestamp and carries the payload/date", () => {
    const now = new Date("2026-02-03T14:30:00.000Z");
    const intent = buildIntent("dose", "2026-02-03", { doseId: 7 }, now);
    expect(intent.flow).toBe("dose");
    expect(intent.date).toBe("2026-02-03");
    expect(intent.capturedAt).toBe("2026-02-03T14:30:00.000Z");
    expect(intent.payload).toEqual({ doseId: 7 });
    expect(intent.key.length).toBeGreaterThan(0);
  });

  it("gives distinct keys to two intents built back-to-back", () => {
    const a = buildIntent("vitals", "2026-01-01", {
      systolic: "120",
      diastolic: "80",
      glucose: null,
      glucoseUnit: null,
      spo2: null,
      temperature: null,
      tempUnit: null,
      sleepHours: null,
      hrv: null,
    });
    const b = buildIntent("vitals", "2026-01-01", {
      systolic: "121",
      diastolic: "81",
      glucose: null,
      glucoseUnit: null,
      spo2: null,
      temperature: null,
      tempUnit: null,
      sleepHours: null,
      hrv: null,
    });
    expect(a.key).not.toBe(b.key);
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
  it("is exactly the three queueable quick-log flows", () => {
    expect([...FLOW_KINDS]).toEqual(["dose", "body-metric", "vitals"]);
  });
});
