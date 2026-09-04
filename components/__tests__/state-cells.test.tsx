import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  StateCells,
  StateLegend,
  stateCellClass,
} from "@/components/StateCells";
import { chartAdherenceState } from "@/lib/chart-colors";

// The convergence's two claims (#4543): ONE geometry per size token across every
// period strip and every key, and no state color from outside `lib/chart-colors`.

const TONE = chartAdherenceState.taken.class;

describe("StateCells geometry", () => {
  it.each([
    ["dot", "h-2.5 w-2.5 rounded-xs"],
    ["cell", "h-4 w-4 rounded-xs"],
    ["tile", "aspect-square rounded-md"],
  ] as const)(
    "%s is one geometry, and carries the tone unchanged",
    (size, geometry) => {
      const cls = stateCellClass(size, TONE);
      for (const token of `${geometry} ${TONE}`.split(" ")) {
        expect(cls).toContain(token);
      }
    }
  );

  it("a strip cell and a legend swatch take their geometry from that table", () => {
    render(
      <>
        <StateCells
          label="Weeks"
          testId="strip"
          cells={[{ key: "w1", tone: TONE, state: "taken" }]}
        />
        <StateLegend
          label="Key"
          testId="key"
          items={[{ key: "taken", tone: TONE, label: "Taken" }]}
        />
      </>
    );
    const cell = screen.getByTestId("strip").firstElementChild!;
    expect(cell.className.trim()).toBe(stateCellClass("cell", TONE));
    expect(cell.getAttribute("data-state")).toBe("taken");
    expect(
      screen.getByTestId("key").querySelector("li > span")!.className
    ).toBe(stateCellClass("dot", TONE));
  });

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
