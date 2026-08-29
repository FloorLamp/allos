import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";

vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
  useConfirmOpen: () => false,
}));
vi.mock("@/components/overlay/AnchoredPanel", () => ({ default: () => null }));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: vi.fn(),
  undoDeletes: vi.fn(),
}));

// WHAT LICENSES THE COLLAPSE (#3904). `logged-event-rows` hides a collapsed row's
// `value`/`meta` cells below `sm`, and the trade only works while the head line
// still carries a fact — identity in `title`, one attribute in `trailing`. A row
// rendering no trailing cell has none, so it must render already open.
//
// ASSERTED HERE AS DOM STATE, NOT AS VISIBILITY: the hiding is a compiled Tailwind
// rule and jsdom applies none of it, so a `toBeVisible` here would pass on every
// tree alike. What this tier CAN see is the two things the CSS keys on — the row's
// `data-expanded` and whether a disclosure control was rendered at all — and the
// rendered consequence is measured at 390px in e2e/logged-event-row.mobile.spec.ts.

interface Row {
  id: number;
  when: string;
  detail: string;
}

const ROW: Row = { id: 1, when: "10:07am", detail: "3 g" };

const IDENTITY: EntryHistoryColumn<Row> = {
  header: "Item",
  slot: "title",
  cell: () => "Magnesium",
};
const DETAIL: EntryHistoryColumn<Row> = {
  header: "Amount",
  slot: "value",
  label: "Amount",
  cell: (row) => row.detail,
};

function trailing(empty?: (row: Row) => boolean): EntryHistoryColumn<Row> {
  return { header: "When", slot: "trailing", empty, cell: (row) => row.when };
}

function renderTable(columns: EntryHistoryColumn<Row>[]) {
  render(
    <EntryHistoryTable
      items={[ROW]}
      columns={columns}
      menuKind="Dose"
      menuItemName={() => "Magnesium"}
      rowTestId={() => "row"}
      renderEditForm={() => null}
      confirmDelete={() => ({ title: "Delete?", message: "Gone." })}
      deleteFormData={() => new FormData()}
      deleteAction={async () => ({ undoId: 1 })}
      deletedMessage="Deleted."
    />
  );
  return screen.getByTestId("row");
}

describe("the collapse is licensed by a trailing cell", () => {
  it.each([
    ["a rendered trailing cell", [IDENTITY, trailing(), DETAIL], true],
    ["no trailing column at all", [IDENTITY, DETAIL], false],
    [
      "a trailing column this row leaves empty",
      [IDENTITY, trailing(() => true), DETAIL],
      false,
    ],
  ] as const)("a row with %s", (what, columns, collapses) => {
    const row = renderTable([...columns]);
    expect(
      row.hasAttribute("data-expanded"),
      `a row with ${what} must render ${collapses ? "collapsed" : "already open"}`
    ).toBe(!collapses);
    expect(
      within(row).queryAllByRole("button", { name: /details$/ })
    ).toHaveLength(collapses ? 1 : 0);
  });
});
