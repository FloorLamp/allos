"use client";

import { useState } from "react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { mergeActivities } from "./actions";

// The Journal's manual pair-merge affordance (issue #64): a kebab (⋯) menu on an
// activity card whose "Merge with…" item reveals a small picker of the OTHER
// activities logged the SAME day. Picking one merges it INTO this card (this card is
// the keeper; the picked sibling is folded in and deleted) via the mergeActivities
// server action — the same fold/decision machinery as the Data → Review resolver,
// but wired through useUndoableDelete so the delete is reversible from a toast.
//
// Renders nothing when the day has no sibling to merge with, so single-activity days
// show no menu at all.
export default function MergeActivityMenu({
  keepId,
  siblings,
}: {
  keepId: number;
  // The same-day, same-profile activities this one can absorb (id + title label).
  siblings: { id: number; title: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const undoable = useUndoableDelete();

  if (siblings.length === 0) return null;

  async function merge(dropId: number) {
    setOpen(false);
    setPicking(false);
    const fd = new FormData();
    fd.set("keep_id", String(keepId));
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
          <button
            type="button"
            role="menuitem"
            data-testid="merge-with"
            className={MENU_ITEM}
            onClick={() => setPicking(true)}
          >
            Merge with…
          </button>
        )
      }
    </OverflowMenu>
  );
}
