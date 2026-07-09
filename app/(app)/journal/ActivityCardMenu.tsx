"use client";

import { useState } from "react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { ActivityEditData } from "@/components/ActivityForm";
import { mergeActivities } from "./actions";

// The kebab (⋯) action menu on a Journal activity card. Two affordances:
//
//  • "Log again" (issue #29) — opens a CREATE form pre-filled from this activity
//    (title, exercises, sets) with the date reset to today, so repeating a
//    session is one tap + a save. Always available.
//  • "Merge with…" (issue #64) — reveals a picker of the OTHER activities logged
//    the SAME day and folds the chosen one into this card (this card is the
//    keeper) via mergeActivities, wired through useUndoableDelete so the delete
//    is reversible from a toast. Shown only when the day has a sibling to absorb.
export default function ActivityCardMenu({
  activity,
  siblings,
}: {
  // The full card activity — the source for "Log again".
  activity: ActivityEditData;
  // The same-day, same-profile activities this one can absorb (id + title label).
  siblings: { id: number; title: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const undoable = useUndoableDelete();
  const { openRepeat } = useActivityEditor();

  async function merge(dropId: number) {
    setOpen(false);
    setPicking(false);
    const fd = new FormData();
    fd.set("keep_id", String(activity.id));
    fd.set("drop_id", String(dropId));
    await undoable(mergeActivities, fd, {
      deletedMessage: "Activities merged.",
    });
  }

  return (
    <OverflowMenu
      label="Activity actions"
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPicking(false);
      }}
    >
      {() =>
        picking ? (
          <div data-testid="merge-picker">
            <div className="px-3 py-1.5 text-xs font-medium text-slate-400 dark:text-slate-500">
              Merge into this — pick one to absorb
            </div>
            <div className="max-h-56 overflow-y-auto">
              {siblings.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  data-testid="merge-target"
                  className={`${MENU_ITEM} truncate`}
                  title={s.title}
                  onClick={() => void merge(s.id)}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="log-again"
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                openRepeat(activity);
              }}
            >
              Log again
            </button>
            {siblings.length > 0 && (
              <button
                type="button"
                role="menuitem"
                data-testid="merge-with"
                className={MENU_ITEM}
                onClick={() => setPicking(true)}
              >
                Merge with…
              </button>
            )}
          </>
        )
      }
    </OverflowMenu>
  );
}
