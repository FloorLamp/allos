import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PracticeHeatmap from "@/components/practices/PracticeHeatmap";
import { buildProtocolHeatmap } from "@/lib/protocol-heatmap";

describe("PracticeHeatmap usage nouns", () => {
  it("calls intake events doses and other usage sessions", () => {
    const { rerender } = render(
      <PracticeHeatmap
        data={buildProtocolHeatmap(
          [{ date: "2026-08-29", count: 2 }],
          "2026-08-29",
          "2026-08-29",
          0,
          "dose"
        )}
      />
    );
    expect(screen.getByText("2 doses across 1 active day")).toBeTruthy();

    rerender(
      <PracticeHeatmap
        data={buildProtocolHeatmap(
          [{ date: "2026-08-29", count: 2 }],
          "2026-08-29",
          "2026-08-29"
        )}
      />
    );
    expect(screen.getByText("2 sessions across 1 active day")).toBeTruthy();
  });
});
