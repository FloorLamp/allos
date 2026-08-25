import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TrendDigestChip from "../TrendDigestChip";
import type { TrendItem } from "@/lib/trends-digest";
import { summarizeTrends } from "@/lib/trends-digest";
import { buildLoggingCadenceDigestSeries } from "@/lib/trends-digest-series";
import { shiftDateStr } from "@/lib/date";
import type { CadenceWindow } from "@/lib/queries/cadence-ledger";

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
  it("renders logging cadence verbatim as a neutral fact without a destination", () => {
    const windows: CadenceWindow[] = Array.from({ length: 8 }, (_, index) => {
      const start = shiftDateStr("2026-01-01", index * 7);
      return {
        start,
        end: shiftDateStr(start, 6),
        isCurrent: false,
        elapsedDays: 7,
      };
    });
    const foodDates = [6, 6, 6, 6, 3, 3, 3, 3].flatMap((count, week) =>
      Array.from({ length: count }, (_, day) =>
        shiftDateStr(windows[week].start, day)
      )
    );
    const [cadence] = summarizeTrends(
      buildLoggingCadenceDigestSeries({
        windows,
        foodDates,
        doseDates: [],
        weighingDates: [],
      })
    );

    render(<TrendDigestChip item={cadence} />);

    const chip = screen.getByTestId("trend-digest-chip");
    expect(cadence.key).toBe("logging:food");
    expect(chip.textContent).toBe(cadence.text);
    expect(chip.textContent).toBe(
      "Food logging ↓ 50% — larger than its recent variation"
    );
    expect(chip.getAttribute("data-tone")).toBe("neutral");
    expect(chip.textContent).not.toMatch(
      /\b(should|must|need to|try to|better|worse|good|bad)\b/i
    );
    expect(chip.closest("a")).toBeNull();
  });

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
