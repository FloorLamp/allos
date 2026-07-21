import { describe, expect, it } from "vitest";
import { isStaleMetricSnapshot } from "@/lib/metric-snapshot";

describe("isStaleMetricSnapshot", () => {
  it("compares absolute instants across ISO offset spellings", () => {
    expect(
      isStaleMetricSnapshot("2026-07-20T20:00:00Z", "2026-07-20T15:00:00-04:00")
    ).toBe(true);
    expect(
      isStaleMetricSnapshot("2026-07-20T20:00:00Z", "2026-07-20T16:00:00-04:00")
    ).toBe(false);
  });

  it("uses a deterministic lexical fallback for legacy local timestamps", () => {
    expect(isStaleMetricSnapshot("later", "earlier")).toBe(true);
  });
});
