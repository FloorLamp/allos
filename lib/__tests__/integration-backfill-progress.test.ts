import { describe, expect, it } from "vitest";
import {
  backfillFailureLabel,
  formatBackfillTime,
  integrationBackfillView,
} from "@/lib/integrations/backfill-progress";

describe("integration backfill progress", () => {
  it("derives percent and ETA from active work plus a provider wait", () => {
    const now = new Date("2026-08-05T12:00:00Z");
    expect(
      integrationBackfillView(
        {
          status: "paused",
          total_items: 100,
          completed_items: 25,
          active_seconds: 50,
          retry_after_at: "2026-08-05T12:10:00Z",
        },
        now
      )
    ).toEqual({
      percent: 25,
      remaining: 75,
      etaSeconds: 750,
      resumesInSeconds: 600,
    });
  });

  it("does not invent an ETA before throughput is observed", () => {
    expect(
      integrationBackfillView({
        status: "running",
        total_items: 12,
        completed_items: 0,
        active_seconds: 3,
        retry_after_at: null,
      }).etaSeconds
    ).toBeNull();
  });

  it("promises a retry only where one is coming (#2196)", () => {
    // A finished job's leftovers cannot be retryable — a retryable failure keeps
    // `remaining > 0`, which ends the run `failed` — so "retrying" was a promise the
    // permanently-unfetchable ride would never keep.
    expect(backfillFailureLabel("completed", 2)).toBe("2 unavailable");
    expect(backfillFailureLabel("failed", 2)).toBe("2 retrying");
    expect(backfillFailureLabel("paused", 1)).toBe("1 retrying");
    expect(backfillFailureLabel("running", 1)).toBe("1 retrying");
  });

  it("says nothing about leftovers when there are none", () => {
    expect(backfillFailureLabel("completed", 0)).toBeNull();
    expect(backfillFailureLabel("failed", 0)).toBeNull();
  });

  it("formats reader-friendly ETA intervals", () => {
    expect(formatBackfillTime(20)).toBe("under a minute");
    expect(formatBackfillTime(601)).toBe("11 min");
    expect(formatBackfillTime(7_500)).toBe("2h 5m");
  });
});
