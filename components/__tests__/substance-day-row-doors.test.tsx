import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConsumptionSection from "@/app/(app)/medical/substance-use/ConsumptionSection";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

// WHICH DOOR A SUBSTANCE CARD'S DAY ROW OPENS (#5026 item 1).
//
// A consumable is an EVENT (owner ruling, 2026-09-04), so the day total is a rollup
// and not the editable thing. These rows are one per DAY, which for nicotine, cannabis
// and every custom key IS the stored fact — their form corrects it. Alcohol's units are
// `food_log_events` rows with their own clocks, so the day form would restate one date
// and one count over every drink beneath it; the drink corrects on its own record row.
//
// BOTH DIRECTIONS, because the two failures are opposite: an alcohol row that still
// offers the day form flattens a day somebody typed two hours into, and a day-count row
// that stops offering it is correctable on no surface at all.

vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  addSubstanceDailyTotalAction: vi.fn(),
  updateSubstanceDailyTotalAction: vi.fn(),
  deleteSubstanceDailyTotalAction: vi.fn(),
  logSubstanceUnitAction: vi.fn(),
  undoSubstanceUnitAction: vi.fn(),
  setSubstanceTargetAction: vi.fn(),
  clearSubstanceTargetAction: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
  useConfirmOpen: () => false,
}));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: vi.fn(),
  undoDeletes: vi.fn(),
}));
// The menu's panel portals through an anchored overlay; this tier needs its ITEMS,
// so the panel renders its children rather than being stubbed away.
vi.mock("@/components/overlay/AnchoredPanel", () => ({
  default: ({
    open,
    children,
  }: {
    open: boolean;
    children: () => React.ReactNode;
  }) => (open ? <div>{children()}</div> : null),
}));

const TODAY = "2026-08-20";
const ENTRY = { date: "2026-08-18", amount: 2, notes: "with dinner" };

afterEach(cleanup);

function card(substance: string, history = [{ id: 4, substance, ...ENTRY }]) {
  render(
    <ConsumptionSection
      substance={substance}
      weekCount={2}
      capSet={false}
      cap={null}
      capProgress={null}
      capAttention={false}
      history={history}
      trend={[]}
      defaultDate={TODAY}
      formatPrefs={DEFAULT_FORMAT_PREFS}
    />
  );
  if (history.length === 0) return null;
  const row = screen.getByTestId(`substance-history-row-${substance}-4`);
  // Reached by the trigger's own testid, not by its accessible name: the sentence is
  // composed in one place (#3501) and lib/__tests__/overflow-menu-identity.test.ts
  // refuses a second spelling of it, this file included.
  fireEvent.click(within(row).getByTestId("overflow-menu-trigger"));
  return row;
}

describe("a substance card's day row opens the door its ledger has (#5026 item 1)", () => {
  it("offers a drink's day no correction form, and says where one drink is corrected", () => {
    card("alcohol");
    // The ⋯ still works and still deletes: a closed door, not a disabled row.
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Delete"]);
    const signpost = screen.getByTestId(
      "substance-history-correct-elsewhere-alcohol"
    );
    expect(within(signpost).getByRole("link").getAttribute("href")).toBe(
      "/history?kind=substance&item=alcohol"
    );

    // …and it names nothing on a card with no days, so it is not said there.
    cleanup();
    card("alcohol", []);
    expect(
      screen.queryByTestId("substance-history-correct-elsewhere-alcohol")
    ).toBeNull();
  });

  it.each(["nicotine", "cannabis", "Kratom"])(
    "still corrects %s's day, which is the thing that happened",
    (substance) => {
      card(substance);
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent)
      ).toEqual(["Edit", "Delete"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      expect(
        screen.getByTestId(`substance-history-edit-form-${substance}`)
      ).toBeTruthy();
      expect(
        screen.queryByTestId(`substance-history-correct-elsewhere-${substance}`)
      ).toBeNull();
    }
  );
});
