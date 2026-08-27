import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import type { IntakeConditionOption } from "@/lib/types";
import PurposesEditor from "@/components/intake/PurposesEditor";
import type { PurposeDraft } from "@/lib/intake-purposes";

// THE PURPOSE CHIP FOR A CONDITION THE PERSON HAS SINCE RESOLVED (#3650).
//
// The picker source was active-only, which is right for the OPTIONS and wrong for the
// LABELS: the chip fell through to the literal word "condition" and its remove control
// read "Remove condition", so the person could not tell which reason they were about to
// remove. The stored row was never wrong — only the list the name was looked up in.
//
// Rendered rather than asserted on a helper because that is where the defect lived: the
// lookup is in the component, and lib/intake-purposes.purposeLabel — the pure sibling —
// already answered this correctly by returning null.

const CONDITIONS: IntakeConditionOption[] = [
  { id: 5, name: "Migraine", status: "resolved" },
  { id: 6, name: "Iron deficiency", status: "active" },
  { id: 7, name: "Plantar fasciitis", status: "inactive" },
];

function Harness({ rows }: { rows: PurposeDraft[] }) {
  const [drafts, setDrafts] = useState<PurposeDraft[]>(rows);
  return (
    <PurposesEditor
      rows={drafts}
      setRows={setDrafts}
      name="Magnesium glycinate"
      ingredientNames={[]}
      conditions={CONDITIONS}
      fid="new"
    />
  );
}

describe("PurposesEditor names the condition a purpose points at (#3650)", () => {
  it.each([
    [5, "Migraine"],
    [6, "Iron deficiency"],
    [7, "Plantar fasciitis"],
  ])("a purpose on condition %i reads %s", (conditionId, name) => {
    render(<Harness rows={[{ kind: "condition", conditionId }]} />);
    expect(screen.getByTestId("purpose-chips").textContent).toContain(name);
    // The remove control names the same thing the chip does — it is the control a
    // person aims at, and "Remove condition" told them nothing about which.
    expect(
      screen.getByTestId("purpose-remove-0").getAttribute("aria-label")
    ).toBe(`Remove ${name}`);
  });

  // The other half of the split: widening the LABEL source must not widen the OFFER
  // set. Nobody files a new reason against something they have marked resolved.
  it("offers only active conditions in the picker", () => {
    render(<Harness rows={[]} />);
    const options = [
      ...screen.getByTestId("purpose-condition").querySelectorAll("option"),
    ].map((o) => o.textContent);
    expect(options).toEqual(["Add a condition…", "Iron deficiency"]);
  });

  // With nothing active left to add, the picker itself does not render — a select whose
  // only entry is its own placeholder is a control that cannot do anything.
  it("hides the picker when no condition is active", () => {
    render(
      <PurposesEditor
        rows={[]}
        setRows={() => {}}
        name="Magnesium glycinate"
        ingredientNames={[]}
        conditions={[CONDITIONS[0]]}
        fid="new"
      />
    );
    expect(screen.queryByTestId("purpose-condition")).toBeNull();
  });
});
