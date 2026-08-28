import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatBox } from "@/components/StatBox";

// The blessed stat tile's rendered anatomy (#3475), pinned at the shapes the
// converged equipment detail grid (#3775) hands it: a label, a value, an
// OPTIONAL sub line, and the e2e test id. `sub={null}` is the live shape from
// that page's "Last used" tile — a stat with no date to print must draw no
// third line at all, not an empty one, or the grid rows stop lining up.
describe("StatBox", () => {
  it.each([
    ["value only", { label: "Sessions", value: "12" }, null],
    [
      "subcopy",
      { label: "Own weight", value: "20 kg", sub: "reference" },
      "reference",
    ],
    ["absent subcopy", { label: "Last used", value: "never", sub: null }, null],
  ])("renders %s", (_name, props, sub) => {
    render(<StatBox {...props} data-testid="tile" />);
    const tile = screen.getByTestId("tile");
    expect(tile.className).toContain("stat-tile");
    expect(tile.querySelector("dt")?.textContent).toBe(props.label);
    expect(tile.querySelectorAll("dd")[0]?.textContent).toBe(props.value);
    expect(tile.querySelectorAll("dd")).toHaveLength(sub ? 2 : 1);
    if (sub) expect(tile.querySelectorAll("dd")[1]?.textContent).toBe(sub);
  });
});
