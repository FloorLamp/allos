"use client";

import { useState } from "react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { moveSaved, toggleSavedItem } from "@/app/(app)/saved/actions";

// The corner ⋯ menu on a Trends Overview tile (#1485 B) — the tile's own controls,
// off the tile's vertical budget.
//
// They used to be a FOOTER ROW under every sparkline: a ★ button plus two reorder
// arrows, ~90px per tile, nine tiles deep on a phone. The affordances are unchanged
// (same server actions, same `star-toggle` / `saved-move-up` / `saved-move-down`
// hooks); they now live behind the 40px kebab every other row action in the app uses
// (the #1488/#1491 standard), which is also how the tile grid can go two-abreast at
// 390px without the controls eating the tile.
//
// Every tile on Overview is a SAVED tile now (#1487 — the grid is membership-driven),
// so the star item is always the UNSAVE; a tile with nothing to show still renders
// (compacted) precisely so this gesture stays reachable at any window — the #1456
// contract. Compaction, not omission.
//
// The reorder items are the #1485 C carry-over: arrows survive as the non-pointer /
// AT fallback inside the menu (drag-lift on the tile itself is a later wave), which
// is exactly where that issue says they belong. They move the tile within the
// profile's SAVED order — which is the persisted order, not necessarily the rendered
// one (an empty tile is sunk to the bottom of the grid; see OverviewSection).
export default function TrendTileMenu({
  itemKey,
  label,
  isFirst,
  isLast,
}: {
  itemKey: string;
  label: string;
  // Ends of the saved list: a move off either end is a server-side no-op, but
  // offering it would be a lie.
  isFirst: boolean;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The save actions return a FormResult; the menu's runAction wants a void-returning
  // action, so each is wrapped. The only failure they can report is an unparseable
  // key, which is impossible for a key this component rendered — a genuine throw is
  // still caught by runAction and toasted.
  const star = async (f: FormData): Promise<void> => {
    await toggleSavedItem(f);
  };
  const move = async (f: FormData): Promise<void> => {
    await moveSaved(f);
  };
  const fd = (extra?: Record<string, string>): FormData => {
    const f = new FormData();
    f.set("key", itemKey);
    for (const [k, v] of Object.entries(extra ?? {})) f.set(k, v);
    return f;
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
          <button
            type="button"
            role="menuitem"
            disabled={isFirst}
            data-testid="saved-move-up"
            className={`${MENU_ITEM} disabled:opacity-40`}
            onClick={() =>
              void runAction(move, fd({ dir: "up" }), `Moved ${label} earlier.`)
            }
          >
            Move earlier
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={isLast}
            data-testid="saved-move-down"
            className={`${MENU_ITEM} disabled:opacity-40`}
            onClick={() =>
              void runAction(move, fd({ dir: "down" }), `Moved ${label} later.`)
            }
          >
            Move later
          </button>
        </div>
      )}
    </OverflowMenu>
  );
}
