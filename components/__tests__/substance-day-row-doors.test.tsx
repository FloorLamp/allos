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

// WHICH DOOR A SUBSTANCE CARD'S DAY ROW OPENS (#5026 items 1 and 2).
//
// A consumable is an EVENT (owner ruling, 2026-09-04), so the day total is a rollup and
// not the editable thing. Phase 1 closed the day form for alcohol alone and left it
// standing for nicotine, cannabis and custom keys, because for them the day still WAS
// the stored fact; phase 2 gave those keys their own use events, so the form has no
// subject left on any card and the ⋯ offers Delete alone everywhere.
//
// THE ROW IS NOT DISABLED, and that is the half worth pinning: the day-level DELETE
// stays (it removes them all and restates nothing — item 1's ruling 2), and the row
// says where one use IS corrected rather than leaving somebody to find out.

vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  addSubstanceDailyTotalAction: vi.fn(),
  correctSubstanceUseAction: vi.fn(),
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
const ENTRY = { date: "2026-08-18", amount: 2 };

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

describe("a substance card's day row opens the door its ledger has (#5026)", () => {
  it.each(["alcohol", "nicotine", "cannabis", "Kratom"])(
    "%s: the day offers Delete alone, and names where one use is corrected",
    (substance) => {
      card(substance);
      // The ⋯ still works and still deletes: a closed door, not a disabled row.
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent)
      ).toEqual(["Delete"]);
      const signpost = screen.getByTestId(
        `substance-history-correct-elsewhere-${substance}`
      );
      expect(within(signpost).getByRole("link").getAttribute("href")).toBe(
        `/history?kind=substance&item=${substance}`
      );

      // …and it names nothing on a card with no days, so it is not said there.
      cleanup();
      card(substance, []);
      expect(
        screen.queryByTestId(`substance-history-correct-elsewhere-${substance}`)
      ).toBeNull();
    }
  );
});
