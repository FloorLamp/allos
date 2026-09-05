import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SessionTelemetryChart from "@/app/(app)/training/activity/[id]/SessionTelemetryChart";
import type { SessionTrace } from "@/lib/cycling-analytics";

// #5002 moved this picker off `SegmentedControl` fill mode, where seven labels in a
// 342px track could only wrap inside the word. The strip's LOOK is the e2e's to hold;
// what belongs here is the one thing a reader hears rather than sees, which changed
// hands in the swap: the zero-only trace's announcement used to reach them through
// `SegmentedControl`, and now reaches them through `Chip`.

function trace(
  key: SessionTrace["key"],
  shortLabel: string,
  values: (number | null)[]
): SessionTrace {
  return {
    key,
    label: shortLabel,
    shortLabel,
    unit: "",
    decimals: 0,
    points: values.map((value, index) => ({ date: `0:0${index}`, value })),
  };
}

afterEach(cleanup);

describe("the ride's recorded-metrics picker", () => {
  it("says why a flat line at 0 is not missing data", () => {
    render(
      <SessionTelemetryChart
        traces={[
          trace("velocity_smooth", "Speed", [11, 12]),
          trace("watts", "Power", [0, 0]),
        ]}
      />
    );

    const group = screen.getByRole("group", { name: "Recorded metrics" });
    expect(
      screen.getByRole("button", { name: "Speed" }).getAttribute("aria-pressed")
    ).toBe("true");
    // The zero-only trace is announced, and the announcement REPLACES the label
    // rather than sitting beside it, so a reader hears one name for one control.
    const zeroOnly = screen.getByRole("button", {
      name: "Power, all recorded values are 0",
    });
    expect(group.contains(zeroOnly)).toBe(true);
    expect(screen.queryByRole("button", { name: "Power" })).toBeNull();
    // And it is not a hover-only hint: nothing in the strip carries a `title`
    // (#3375), which is why the announcement has to be the accessible name.
    expect(group.querySelector("[title]")).toBeNull();

    fireEvent.click(zeroOnly);
    expect(zeroOnly.getAttribute("aria-pressed")).toBe("true");
  });

  it("draws no picker for a session with one trace to show", () => {
    render(
      <SessionTelemetryChart
        traces={[trace("heartrate", "Heart rate", [120, 130])]}
      />
    );

    expect(
      screen.queryByRole("group", { name: "Recorded metrics" })
    ).toBeNull();
  });
});
