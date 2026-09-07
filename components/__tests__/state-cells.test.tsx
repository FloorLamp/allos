import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StateCells } from "@/components/StateCells";
import { chartAdherenceState } from "@/lib/chart-colors";

const TONE = chartAdherenceState.taken.class;

describe("StateCells access", () => {
  it("a cell with an href is a link the reader can open; one without is not", () => {
    render(
      <StateCells
        label="Days"
        testId="strip"
        cells={[
          {
            key: "a",
            tone: TONE,
            state: "1",
            label: "Monday",
            href: "/training",
          },
          { key: "b", tone: TONE, state: "0", label: "Tuesday" },
        ]}
      />
    );
    expect(screen.getByRole("link", { name: "Monday" })).toHaveProperty(
      "tagName",
      "A"
    );
    expect(screen.queryByRole("link", { name: "Tuesday" })).toBeNull();
    // A named period without a destination is still a door to its name (#4760):
    // focusable, and the readout is the name itself.
    const named = screen.getByRole("img", { name: "Tuesday" });
    expect([named.tagName, named.tabIndex]).toEqual(["SPAN", 0]);
    expect(named.classList.contains("series-point")).toBe(true);
  });

  it("an unnamed cell is paint only — no focus stop, no readout", () => {
    render(
      <StateCells
        label="Weeks"
        testId="strip"
        cells={[{ key: "w1", tone: TONE, state: "taken" }]}
      />
    );
    const cell = screen.getByTestId("strip").firstElementChild!;
    expect(cell.hasAttribute("tabindex")).toBe(false);
    expect(cell.classList.contains("series-point")).toBe(false);
  });
});
