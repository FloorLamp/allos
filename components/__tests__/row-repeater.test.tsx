import { describe, expect, it } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import RowRepeater, {
  RowRemoveButton,
  useRowList,
} from "@/components/RowRepeater";
import DoseRowsEditor, {
  emptyDose,
  type DoseState,
} from "@/components/intake/DoseRowsEditor";
import IngredientsEditor, {
  type IngredientState,
} from "@/components/intake/IngredientsEditor";
import IntakeRulesEditor from "@/components/intake/IntakeRulesEditor";
import PurposesEditor from "@/components/intake/PurposesEditor";
import type { IntakeRule } from "@/lib/intake-rules";
import type { PurposeDraft } from "@/lib/intake-purposes";

// THE ROW-REPEATER PRIMITIVE AND ITS ADOPTERS (#4672).
//
// The hook's three operations and the two controls are tested here; each adopting
// editor then gets one mount that proves it reaches the shared implementation, since a
// re-spelled copy would pass every test written against the primitive alone.
//
// `CadenceEditor` is deliberately absent: it edits ONE draft object, not a list of
// rows, so there is nothing here for it to adopt.

// ---- The hook ----

function Counter({ start }: { start: { n: number; tag?: string }[] }) {
  const [rows, setRows] = useState(start);
  const list = useRowList(setRows);
  return (
    <div>
      <output data-testid="rows">{JSON.stringify(rows)}</output>
      <button onClick={() => list.patch(1, { n: 99 })}>patch</button>
      <button onClick={() => list.remove(1)}>remove</button>
      <button onClick={() => list.add({ n: 7 })}>add</button>
      {/* Two edits in ONE event: the second must see the first. This is what the
          functional updater buys, and the shape every editor used to hand-roll. */}
      <button
        onClick={() => {
          list.patch(0, { n: 1 });
          list.patch(0, { tag: "both" });
        }}
      >
        twice
      </button>
    </div>
  );
}

const START = [{ n: 10 }, { n: 20 }, { n: 30 }];
const rowsJson = () => screen.getByTestId("rows").textContent;

describe("useRowList", () => {
  it.each([
    ["patch", '[{"n":10},{"n":99},{"n":30}]'],
    ["remove", '[{"n":10},{"n":30}]'],
    ["add", '[{"n":10},{"n":20},{"n":30},{"n":7}]'],
  ])("%s addresses exactly one row", (control, expected) => {
    render(<Counter start={START} />);
    fireEvent.click(screen.getByText(control));
    expect(rowsJson()).toBe(expected);
  });

  it("composes two patches of the same row in one batch", () => {
    render(<Counter start={START} />);
    act(() => {
      fireEvent.click(screen.getByText("twice"));
    });
    expect(rowsJson()).toBe('[{"n":1,"tag":"both"},{"n":20},{"n":30}]');
  });
});

// ---- The shell ----

function Shell({ rows, withEmpty }: { rows: string[]; withEmpty: boolean }) {
  return (
    <RowRepeater
      rows={rows}
      testId="shell"
      header={<div>Header</div>}
      add={{ label: "Add one", testId: "add", onClick: () => {} }}
      empty={
        withEmpty
          ? { label: "Start a list", testId: "start", onClick: () => {} }
          : undefined
      }
    >
      {rows.map((r) => (
        <div key={r}>{r}</div>
      ))}
    </RowRepeater>
  );
}

describe("RowRepeater", () => {
  it("offers one add affordance for a list that has rows", () => {
    render(<Shell rows={["a"]} withEmpty />);
    expect(screen.getByTestId("add")).toBeTruthy();
    expect(screen.queryByTestId("start")).toBeNull();
    expect(screen.getByText("Header")).toBeTruthy();
  });

  // A heading over an empty list is a section about nothing, so the first-row
  // invitation replaces the whole block rather than sitting under it.
  it("replaces the block with the first-row invitation when empty", () => {
    render(<Shell rows={[]} withEmpty />);
    expect(screen.getByTestId("start")).toBeTruthy();
    expect(screen.queryByTestId("add")).toBeNull();
    expect(screen.queryByText("Header")).toBeNull();
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("keeps its heading and add button when a list has no invitation", () => {
    render(<Shell rows={[]} withEmpty={false} />);
    expect(screen.getByText("Header")).toBeTruthy();
    expect(screen.getByTestId("add")).toBeTruthy();
  });
});

describe("RowRemoveButton", () => {
  // The control box and its reach are #4505's, spelled once. Asserted because the
  // divergence this primitive removes was three hand-rolled copies of exactly this.
  it("names its row and carries the shared control box", () => {
    render(<RowRemoveButton label="Remove ingredient 2" onClick={() => {}} />);
    const cls = screen.getByLabelText("Remove ingredient 2").className;
    expect(cls).toContain("tap-target");
    expect(cls).toContain("h-(--control-box)");
    expect(cls).toContain("w-(--control-box)");
  });
});

// ---- One mount per adopter ----

function Doses() {
  const [doses, setDoses] = useState<DoseState[]>([
    emptyDose("100 mg"),
    emptyDose("200 mg"),
  ]);
  return (
    <DoseRowsEditor doses={doses} setDoses={setDoses} dosageOptions={[]} />
  );
}

function Ingredients() {
  const [rows, setRows] = useState<IngredientState[]>([]);
  return <IngredientsEditor rows={rows} setRows={setRows} />;
}

function Rules() {
  const [rules, setRules] = useState<IntakeRule[]>([
    { id: "a", type: "food", timing: "with_food" },
    { id: "b", type: "food", timing: "empty_stomach" },
  ]);
  return <IntakeRulesEditor rules={rules} setRules={setRules} others={[]} />;
}

function Purposes() {
  const [rows, setRows] = useState<PurposeDraft[]>([
    { kind: "goal", goalKey: "sleep" },
    { kind: "goal", goalKey: "mood" },
  ]);
  return (
    <PurposesEditor
      rows={rows}
      setRows={setRows}
      name="Magnesium"
      ingredientNames={[]}
      fid="new"
    />
  );
}

describe("the editors that adopt the repeater", () => {
  it("DoseRowsEditor removes the row its control names", () => {
    render(<Doses />);
    fireEvent.click(screen.getAllByLabelText("Remove dose")[0]);
    expect(screen.getByLabelText("Amount").getAttribute("value")).toBe(
      "200 mg"
    );
    // One row left, so the per-row remove is gone and only the add remains.
    expect(screen.queryByLabelText("Remove dose")).toBeNull();
    expect(screen.getByText("Add dose")).toBeTruthy();
  });

  // The ingredients list's two add affordances used to live in two files — the
  // first-row invitation in the parent form, the row add here.
  it("IngredientsEditor owns both of its add affordances", () => {
    render(<Ingredients />);
    expect(screen.queryByTestId("add-ingredient")).toBeNull();
    fireEvent.click(screen.getByTestId("add-ingredients"));
    expect(screen.getByTestId("ingredient-name-0")).toBeTruthy();
    expect(screen.getByTestId("add-ingredient")).toBeTruthy();
    expect(screen.queryByTestId("add-ingredients")).toBeNull();
  });

  it("IntakeRulesEditor removes the rule its control sits on", () => {
    render(<Rules />);
    fireEvent.click(screen.getAllByLabelText("Remove rule")[0]);
    const rows = screen.getAllByTestId("intake-rule-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector<HTMLSelectElement>("select")?.value).toBe(
      "empty_stomach"
    );
  });

  it("PurposesEditor removes the chip its control sits on", () => {
    render(<Purposes />);
    fireEvent.click(screen.getByTestId("purpose-remove-0"));
    expect(screen.getByTestId("purpose-chips").textContent).toBe("Mood");
  });
});
