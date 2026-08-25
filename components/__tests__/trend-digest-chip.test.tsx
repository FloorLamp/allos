import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TrendDigestChip from "../TrendDigestChip";
import type { TrendItem } from "@/lib/trends-digest";

function item(over: Partial<TrendItem> = {}): TrendItem {
  return {
    key: "result:Example",
    label: "Example",
    direction: "up",
    first: 90,
    last: 110,
    absChange: 20,
    pctChange: 20 / 90,
    days: 10,
    count: 2,
    rangeShift: "out-of-range",
    admissionReason: "range-crossing",
    lastStatus: "above",
    magnitude: 1000,
    text: "Example ↑ 22% — high",
    ...over,
  };
}

describe("TrendDigestChip", () => {
  it("renders a newly notable non-optimal/lab-reported verdict in the shared warning tone without an arrow", () => {
    render(
      <TrendDigestChip
        item={item({
          direction: "flat",
          first: 90,
          last: 90,
          absChange: 0,
          pctChange: 0,
          storedFlagTone: "warn",
          text: "Example — above reported range",
        })}
      />
    );

    const chip = screen.getByTestId("trend-digest-chip");
    expect(chip.getAttribute("data-tone")).toBe("warn");
    expect(chip.querySelector("svg")).toBeNull();
  });

  it("keeps an app out-of-range transition red and renders its numeric arrow", () => {
    render(<TrendDigestChip item={item({ storedFlagTone: "bad" })} />);

    const chip = screen.getByTestId("trend-digest-chip");
    expect(chip.getAttribute("data-tone")).toBe("bad");
    expect(chip.querySelector("svg")).not.toBeNull();
  });
});
