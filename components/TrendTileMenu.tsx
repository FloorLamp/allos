"use client";

import { useState } from "react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { useTileReorder } from "@/components/SavedTilesGrid";
import { toggleSavedItem } from "@/app/(app)/saved-actions";

// The corner ⋯ menu on a Trends Overview tile (#1485 B) — the tile's own controls,
// off the tile's vertical budget.
//
// They used to be a FOOTER ROW under every sparkline: a ★ button plus two reorder
// arrows, ~90px per tile, nine tiles deep on a phone. The affordances are unchanged
// (same `star-toggle` / `saved-move-up` / `saved-move-down` hooks); they now live
// behind the 40px kebab every other row action in the app uses (the #1488/#1491
// standard), which is also how the tile grid can go two-abreast at 390px without
// the controls eating the tile.
//
// Every tile on Overview is a SAVED tile now (#1487 — the grid is membership-driven),
// so the star item is always the UNSAVE; a tile with nothing to show still renders
// (compacted) precisely so this gesture stays reachable at any window — the #1456
// contract. Compaction, not omission.
//
// THE ARROWS ARE THE NON-POINTER FALLBACK (#1485 C). Drag is now the reorder
// language (long-press to lift on touch, through the shared mechanism in
// components/SortableOrder.tsx), and these two items are what a keyboard or an AT
// user reaches for instead. They are deliberately NOT a second implementation: the
// list, the step and the write all come from the grid through SavedTilesGrid's
// reorder context, so an arrow and a drag move the same tile through the same
// order into the same `saved_items.position` sweep.
//
// A tile that cannot be reordered — an EMPTY one, sunk below the grid by rule
// because it has nothing to show at this window — offers no arrows at all, rather
// than two controls that would visibly do nothing. Its unstar stays, which is the
// only thing #1456 requires of it.
export default function TrendTileMenu({
  itemKey,
  label,
}: {
  itemKey: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const reorder = useTileReorder();
  const index = reorder ? reorder.keys.indexOf(itemKey) : -1;
  const reorderable = reorder != null && index >= 0;
  // The save action returns a FormResult; the menu's runAction wants a
  // void-returning action, so it is wrapped. The only failure it can report is an
  // unparseable key, which is impossible for a key this component rendered — a
  // genuine throw is still caught by runAction and toasted.
  const star = async (f: FormData): Promise<void> => {
    await toggleSavedItem(f);
  };
  const fd = (): FormData => {
    const f = new FormData();
    f.set("key", itemKey);
    return f;
  };
  // The reorder step is optimistic client state plus a persist the grid owns (it
  // reverts and toasts on failure), handed to runAction purely to reuse the menu's
  // close-and-confirm behaviour.
  const step = (direction: "up" | "down") => async (): Promise<void> => {
    reorder?.move(itemKey, direction);
  };
  return (
    <OverflowMenu label={`${label} actions`} open={open} onOpenChange={setOpen}>
      {({ runAction }) => (
        <div data-testid="trend-tile-menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked
            data-testid="star-toggle"
            className={MENU_ITEM}
            onClick={() => void runAction(star, fd(), `Unstarred ${label}.`)}
          >
            ★ Unstar
          </button>
          {reorderable && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={index === 0}
                data-testid="saved-move-up"
                className={`${MENU_ITEM} disabled:opacity-40`}
                onClick={() =>
                  void runAction(step("up"), fd(), `Moved ${label} earlier.`)
                }
              >
                Move earlier
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={index === reorder.keys.length - 1}
                data-testid="saved-move-down"
                className={`${MENU_ITEM} disabled:opacity-40`}
                onClick={() =>
                  void runAction(step("down"), fd(), `Moved ${label} later.`)
                }
              >
                Move later
              </button>
            </>
          )}
        </div>
      )}
    </OverflowMenu>
  );
}
