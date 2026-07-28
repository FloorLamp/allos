import { describe, expect, it } from "vitest";
import { buildProtocolHeatmap } from "@/lib/protocol-heatmap";

describe("buildProtocolHeatmap (#1588)", () => {
  it("keeps event-count intensity and distinguishes window padding from zero", () => {
    const heatmap = buildProtocolHeatmap(
      [
        { date: "2026-07-06", count: 1 },
        { date: "2026-07-07", count: 2 },
        { date: "2026-07-08", count: 4 },
      ],
      "2026-07-06",
      "2026-07-10",
      0
    );
    const cells = heatmap.columns.flat();

    expect(cells.find((cell) => cell.date === "2026-07-05")).toMatchObject({
      outside: true,
      count: 0,
    });
    expect(cells.find((cell) => cell.date === "2026-07-09")).toMatchObject({
      outside: false,
      count: 0,
      level: 0,
    });
    expect(cells.find((cell) => cell.date === "2026-07-07")).toMatchObject({
      outside: false,
      count: 2,
      level: 2,
    });
    expect(cells.find((cell) => cell.date === "2026-07-08")).toMatchObject({
      count: 4,
      level: 4,
    });
    expect(heatmap.totalSessions).toBe(7);
    expect(heatmap.activeDays).toBe(3);
  });

  it("spans long windows without dropping early days", () => {
    const heatmap = buildProtocolHeatmap(
      [{ date: "2025-01-01", count: 1 }],
      "2025-01-01",
      "2026-01-01",
      1
    );
    const cells = heatmap.columns.flat();
    expect(heatmap.columns.length).toBeGreaterThanOrEqual(53);
    expect(cells.some((cell) => cell.date === "2025-01-01")).toBe(true);
    expect(cells.some((cell) => cell.date === "2026-01-01")).toBe(true);
  });
});
