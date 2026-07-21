import { describe, expect, it } from "vitest";
import {
  boundSyncDetailsJson,
  MAX_SYNC_DETAILS_CHARS,
  originChoiceLabel,
  parseHealthConnectSyncDetails,
  serializeHealthConnectSyncDetails,
} from "@/lib/integrations/sync-details";

describe("Health Connect sync details", () => {
  it("parses safe diagnostics and formats known origin package names", () => {
    const parsed = parseHealthConnectSyncDetails(
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
    expect(parseHealthConnectSyncDetails("not json")).toBeNull();
    expect(parseHealthConnectSyncDetails("{}")).toBeNull();
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
    const raw = serializeHealthConnectSyncDetails(details)!;
    expect(raw.length).toBeLessThanOrEqual(MAX_SYNC_DETAILS_CHARS);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(parseHealthConnectSyncDetails(raw)?.origins.length).toBeGreaterThan(
      0
    );
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
