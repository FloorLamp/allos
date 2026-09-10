import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoutinesManager from "@/app/(app)/training/RoutinesManager";
import type { RoutineWithDays } from "@/lib/types";

// THE ROUTINE CARD'S ACTION ROW IS ONE SURFACE (#4978 item 3, ruling 3 and
// ruling 5). This row is the densest raw-class surface in `app/(app)/training`:
// one commit-rank control (`Activate`, a raw `.btn`) beside three quiet ones
// (`Restart cycle`, `Edit`, `Delete`, raw `.btn-ghost`), and the Delete was the
// red-tinted ghost the owner ruled on at 2026-09-09 20:05 UTC.
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

  it("paints Delete as the one destructive treatment, not a red-tinted ghost", () => {
    renderCard();
    const remove = screen.getByTestId("routine-delete");
    // Owner ruling 5: destructive actions look the same everywhere, and no
    // red-tinted ghost variant exists to spell this any other way.
    expect(remove.className).toContain("button-control-danger");
    expect(remove.className).not.toMatch(/text-rose/);
  });

  it("states no primary: Activate is a per-card commit, not the surface's one action", () => {
    const card = renderCard();
    // Every card in the grid carries its own Activate, so the filled paint cannot
    // be spent here. #4978's question about non-form commits on a multi-card route
    // is open; promoting this control must break this line rather than land quietly.
    expect(card.querySelectorAll(".button-control-primary")).toHaveLength(0);
    expect(screen.getByTestId("routine-activate").className).toBe(
      screen.getByTestId("routine-edit").className
    );
  });
});
