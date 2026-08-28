import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SetupStepsCard from "@/components/integrations/SetupStepsCard";

// The card's whole job is anatomy, so the assertions are anatomical: one level-2
// heading, one <ol>, one <li> PER STEP in the given order, token rows above the
// list and the note below it. The six integration pages used to decide each of
// these separately (#3777).
describe("SetupStepsCard", () => {
  it("renders a semantic ordered list under a level-2 heading", () => {
    const { container } = render(
      <SetupStepsCard title="Setup" steps={["first", "second", "third"]} />
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Setup");
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent)
    ).toEqual(["first", "second", "third"]);
    expect(container.firstElementChild?.className).toContain("card");
  });

  // Both optional regions are absent by default and each has exactly one home:
  // the copy targets sit between the heading and step 1 (Strava and Withings
  // step 1 both say "the URL above"), the note after the last step.
  it.each([
    ["neither", {}, 0, false],
    [
      "token rows",
      { tokenRows: [{ label: "Callback URI", value: "url one" }] },
      1,
      false,
    ],
    ["a note", { note: "keep it private" }, 0, true],
  ])("renders %s", (_name, extra, rows, hasNote) => {
    const { container } = render(
      <SetupStepsCard title="Setup" steps={["only step"]} {...extra} />
    );
    const kids = [...container.firstElementChild!.children];
    expect(kids.map((k) => k.tagName)).toEqual([
      "H2",
      ...Array(rows).fill("DIV"),
      "OL",
      ...(hasNote ? ["P"] : []),
    ]);
    if (rows) expect(screen.getByText("Callback URI")).toBeTruthy();
    if (hasNote) expect(screen.getByText("keep it private").tagName).toBe("P");
  });

  it("keeps inline step content inside its own list item", () => {
    render(
      <SetupStepsCard
        title="Setup"
        steps={[
          <>
            Sign in at <a href="https://example.test/tokens">the console</a> and{" "}
            <strong>create a token</strong>.
          </>,
        ]}
      />
    );
    const step = screen.getByRole("listitem");
    expect(within(step).getByRole("link").getAttribute("href")).toBe(
      "https://example.test/tokens"
    );
    expect(within(step).getByText("create a token").tagName).toBe("STRONG");
  });
});
