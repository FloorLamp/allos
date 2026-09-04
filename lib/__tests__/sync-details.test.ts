import { describe, expect, it } from "vitest";
import {
  boundSyncDetailsJson,
  isTruncatedSyncEvent,
  MAX_SYNC_DETAILS_CHARS,
  originChoiceLabel,
  parseSyncEventDetails,
  serializeSyncEventDetails,
  TRUNCATED_SYNC_WARNING,
  truncatedSyncDetails,
} from "@/lib/integrations/sync-details";

describe("Health Connect sync details", () => {
  it("parses safe diagnostics and formats known origin package names", () => {
    const parsed = parseSyncEventDetails(
      JSON.stringify({
        warnings: ["heart_rate records were all skipped"],
        origins: [
          {
            date: "2026-07-20",
            metric: "total_kcal",
            chosen: "com.garmin.android.apps.connectmobile",
            ignored: ["com.fitbit.FitbitMobile"],
          },
        ],
      })
    );
    expect(parsed?.warnings).toEqual(["heart_rate records were all skipped"]);
    expect(originChoiceLabel(parsed!.origins[0])).toBe(
      "Total calories: Garmin used · Fitbit ignored as duplicate"
    );
  });

  it("ignores malformed or empty stored details", () => {
    expect(parseSyncEventDetails("not json")).toBeNull();
    expect(parseSyncEventDetails("{}")).toBeNull();
  });

  it("bounds structured arrays while preserving valid JSON", () => {
    const details = {
      warnings: ["shape warning".repeat(100)],
      origins: Array.from({ length: 100 }, (_, index) => ({
        date: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
        metric: `metric_${index}`,
        chosen: `com.example.chosen.${index}.${"x".repeat(300)}`,
        ignored: [`com.example.ignored.${index}.${"y".repeat(300)}`],
      })),
    };
    const raw = serializeSyncEventDetails(details)!;
    expect(raw.length).toBeLessThanOrEqual(MAX_SYNC_DETAILS_CHARS);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(parseSyncEventDetails(raw)?.origins.length).toBeGreaterThan(0);
  });

  it("defensively reserializes an oversized direct-caller value", () => {
    const raw = JSON.stringify({
      warnings: [],
      origins: Array.from({ length: 100 }, (_, index) => ({
        date: "2026-07-20",
        metric: `metric_${index}`,
        chosen: `origin_${index}`,
        ignored: [`duplicate_${index}`],
      })),
    });
    const bounded = boundSyncDetailsJson(raw)!;
    expect(bounded.length).toBeLessThanOrEqual(MAX_SYNC_DETAILS_CHARS);
    expect(() => JSON.parse(bounded)).not.toThrow();
  });
});

// The truncation marker (#1614): a pull stopped by a page cap / rate limit rides the
// SAME details JSON, so a partial run is distinguishable from a clean success without
// a schema change.
describe("truncated pull marker", () => {
  it("round-trips the marker and its Review line", () => {
    const raw = truncatedSyncDetails();
    const parsed = parseSyncEventDetails(raw);
    expect(parsed?.truncated).toBe(true);
    expect(parsed?.warnings).toEqual([TRUNCATED_SYNC_WARNING]);
    expect(isTruncatedSyncEvent({ details: raw })).toBe(true);
  });

  it("treats a complete run, an absent details value, and junk as not truncated", () => {
    expect(isTruncatedSyncEvent({ details: null })).toBe(false);
    expect(isTruncatedSyncEvent({})).toBe(false);
    expect(isTruncatedSyncEvent({ details: "not json" })).toBe(false);
    expect(
      isTruncatedSyncEvent({
        details: JSON.stringify({ warnings: ["ordinary"], origins: [] }),
      })
    ).toBe(false);
    // Only a literal `true` marks the run — a stray string must not badge it.
    expect(
      isTruncatedSyncEvent({
        details: JSON.stringify({
          warnings: [],
          origins: [],
          truncated: "yes",
        }),
      })
    ).toBe(false);
  });

  it("survives the char-budget bounding even when the warnings are dropped", () => {
    const raw = serializeSyncEventDetails(
      {
        warnings: ["a very long warning ".repeat(50)],
        origins: [],
        truncated: true,
      },
      60
    )!;
    expect(raw.length).toBeLessThanOrEqual(60);
    expect(parseSyncEventDetails(raw)?.truncated).toBe(true);
  });

  // The per-type tally (#4956) is machine evidence, not a note: it must survive the
  // round trip on a run that carries nothing else, and it must survive the char budget
  // for the same reason `truncated` does — a budget that dropped it would restore
  // exactly the silence the tally exists to end.
  it("round-trips a tally-only payload, budget and all", () => {
    const tally = { heart_rate_variability: { received: 12, landed: 0 } };
    // 120 chars is under the warning's 500-char slice, so the budget genuinely has to
    // choose — and the tally is what must survive the choice.
    const raw = serializeSyncEventDetails(
      { warnings: ["a very long warning ".repeat(50)], origins: [], tally },
      120
    )!;
    expect(parseSyncEventDetails(raw)?.warnings).toEqual([]);
    expect(parseSyncEventDetails(raw)?.tally).toEqual(tally);
    const bare = serializeSyncEventDetails({
      warnings: [],
      origins: [],
      tally,
    });
    expect(bare).not.toBeNull();
    expect(parseSyncEventDetails(bare)?.tally).toEqual(tally);
  });

  // Counts that are not numbers are dropped rather than trusted into a comparison —
  // `details` is durable JSON and past versions wrote no tally at all.
  it("drops tally entries whose counts are not finite numbers", () => {
    expect(
      parseSyncEventDetails(
        JSON.stringify({ tally: { steps: { received: "4", landed: 4 } } })
      )
    ).toBeNull();
  });

  it("serializes a marker-only payload instead of collapsing it to null", () => {
    const raw = serializeSyncEventDetails({
      warnings: [],
      origins: [],
      truncated: true,
    });
    expect(raw).not.toBeNull();
    expect(parseSyncEventDetails(raw)?.truncated).toBe(true);
  });
});
