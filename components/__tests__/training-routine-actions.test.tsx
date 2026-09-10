import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoutinesManager from "@/app/(app)/training/RoutinesManager";
import type { RoutineWithDays } from "@/lib/types";
import { loudIn } from "./loud-controls";

// THE ROUTINE CARD'S ACTION ROW IS ONE SURFACE (#4978 item 3, ruling 3 and
// ruling 10). This row is the densest raw-class surface in `app/(app)/training`:
// one commit-rank control (`Activate`, a raw `.btn`) beside three quiet ones
// (`Restart cycle`, `Edit`, `Delete`, raw `.btn-ghost`), and the Delete was the
// red-tinted ghost the owner ruled on at 2026-09-09 20:05 UTC.
//
// RULING 10 (2026-09-10 01:30 UTC) then narrowed ruling 5: a filled danger spends
// the surface's loud-control budget, so a per-row destructive action in a repeated
// list goes quiet and the fill moves to the confirm step. Ruling 6 makes the CARD
// that surface. So the card's loud budget is asserted card-scoped and WHOLE, over
// both loud paints at once — a per-control assertion cannot see a second fill
// arriving beside the one it checks, and a document-wide count answers for cards
// this test is not about.
//
// The row is asserted WHOLE rather than one control at a time, because the state
// ruling (3) forbids is a MIXED row: a converted commit at the primitive's 12px
// beside a raw 14px ghost, which is Cancel outweighing Save. A per-control
// assertion passes on exactly that row. So the claim here is that the row holds
// no member of the retiring family at all — falsified by the unconverted file and
// by a half-converted one alike.
const unexpectedAction = vi.hoisted(() => () => {
  throw new Error("this test does not submit domain actions");
});

vi.mock("@/app/(app)/training/actions", () => ({
  adoptRoutineTemplateAction: unexpectedAction,
  activateRoutineAction: unexpectedAction,
  deactivateRoutineAction: unexpectedAction,
  deleteRoutineAction: unexpectedAction,
  restartRoutineCycleAction: unexpectedAction,
}));
vi.mock("@/app/(app)/training/RoutineBuilder", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => false,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));

const RAW_FAMILY = /\b(btn|btn-ghost|btn-danger|btn-sm)\b/;

const routine: RoutineWithDays = {
  id: 1,
  profile_id: 1,
  name: "Push Pull Legs",
  source: "template",
  active: 0,
  cycle_weeks: null,
  days: [
    {
      id: 10,
      routine_id: 1,
      position: 0,
      label: "Push",
      focus: ["Chest"],
      slots: [],
    },
  ],
} as unknown as RoutineWithDays;

function renderCard() {
  render(
    <RoutinesManager
      routines={[routine]}
      templates={[]}
      replaceTargets={[]}
      liftOptions={[]}
    />
  );
  return screen.getByTestId("routine-card");
}

afterEach(cleanup);

describe("the routine card's action row (#4978)", () => {
  it("converts the commit and its ghosts together — no raw class survives", () => {
    const card = renderCard();
    const raw = card.querySelectorAll(
      '[class~="btn"], [class~="btn-ghost"], [class~="btn-danger"], [class~="btn-sm"]'
    );
    expect(
      [...raw].map((el) => el.getAttribute("data-testid") ?? el.className),
      "ruling (3): a converted commit beside a raw ghost is the state main must never show"
    ).toEqual([]);

    for (const testId of [
      "routine-activate",
      "routine-edit",
      "routine-delete",
    ]) {
      const control = screen.getByTestId(testId);
      expect(control.getAttribute("data-button-control")).toBe("");
      expect(control.className).toContain("button-control");
      expect(control.className).not.toMatch(RAW_FAMILY);
    }
  });

  it("spends no loud control on the card: the per-row Delete is quiet under ruling 10", () => {
    const card = renderCard();
    // Ruling 10: the per-row Delete goes quiet, and the fill it gives up lands on
    // the confirm `onDelete` opens (a `z-110` dialog, not a control on this card).
    // Ruling 6 leaves Activate quiet too — every card in the grid carries its own,
    // so no one of them is the route's commit. Both facts are ONE claim about this
    // card's loud budget, and it is empty. Re-adding either fill breaks this line.
    expect(
      loudIn(card),
      "ruling 10: a per-row destructive action in a repeated list is not loud"
    ).toEqual([]);
    expect(screen.getByTestId("routine-delete").className).not.toMatch(
      /text-rose/
    );
    expect(screen.getByTestId("routine-activate").className).toBe(
      screen.getByTestId("routine-edit").className
    );
  });
});
