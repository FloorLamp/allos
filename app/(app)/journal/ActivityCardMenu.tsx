"use client";

import { useState } from "react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import { useResumeSyncUpdates } from "@/components/EditLockNotice";
import type { ActivityEditData } from "@/components/ActivityForm";
import type { UnitPrefs } from "@/lib/settings";
import type { FieldConflict } from "@/lib/import-review/conflicts";
import { mergeActivities } from "./actions";

// A same-day sibling this card can absorb: id + label, plus the pre-computed
// conflicts between THIS card (keeper) and the sibling (issue #100). Conflicts are
// computed upstream (JournalView) from both rows' full fold-field values.
export interface MergeSibling {
  id: number;
  title: string;
  // Provenance label for the sibling's values ("Manual" / "Strava" / …).
  sourceLabel: string;
  // Fields where both rows carry differing values — empty in the common case.
  conflicts: FieldConflict[];
  // How many exercise sets this sibling carries — moved onto the keeper by the merge
  // (#199); surfaced in the conflict preview so the user sees what's moving.
  setCount: number;
}

// The kebab (⋯) action menu on a Journal activity card. Its affordances:
//
//  • "Log again" (issue #29) — opens a CREATE form pre-filled from this activity
//    (title, exercises, sets) with the date reset to today, so repeating a
//    session is one tap + a save. Always available.
//  • "Merge with…" (issue #64) — reveals a picker of the OTHER activities logged
//    the SAME day and folds the chosen one into this card (this card is the
//    keeper) via mergeActivities, wired through useUndoableDelete so the delete
//    is reversible from a toast. Shown only when the day has a sibling to absorb.
//    When the two rows genuinely disagree on a field (issue #100), a conflict
//    preview opens first so the user picks per field; with zero conflicts the merge
//    stays a single click, unchanged.
//  • "Resume sync updates" — only for hand-edited integration rows. The compact
//    provenance footer keeps the lock status; this menu owns the deliberate action.
export default function ActivityCardMenu({
  activity,
  siblings,
  keeperLabel,
  editLocked,
  units,
}: {
  // The full card activity — the source for "Log again".
  activity: ActivityEditData;
  // The same-day, same-profile activities this one can absorb.
  siblings: MergeSibling[];
  // Provenance label for THIS card's values (the keeper side in a conflict).
  keeperLabel: string;
  // A hand-edited integration row keeps its compact lock marker in provenance;
  // the deliberate re-enable action lives here rather than lengthening the card.
  editLocked: boolean;
  units: UnitPrefs;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // The sibling whose merge is awaiting per-field conflict resolution, or null.
  const [conflictFor, setConflictFor] = useState<MergeSibling | null>(null);
  const undoable = useUndoableDelete();
  const { openRepeat } = useActivityEditor();
  const { busy: resumingSync, resumeSyncUpdates } = useResumeSyncUpdates(
    "activities",
    activity.id
  );

  async function runMerge(dropId: number, overrideFields: string[]) {
    const fd = new FormData();
    fd.set("keep_id", String(activity.id));
    fd.set("drop_id", String(dropId));
    if (overrideFields.length > 0)
      fd.set("overrides", JSON.stringify(overrideFields));
    await undoable(mergeActivities, fd, {
      deletedMessage: "Activities merged.",
    });
  }

  function pick(sibling: MergeSibling) {
    setOpen(false);
    setPicking(false);
    // Conflicts ⇒ open the preview; otherwise merge in one click (unchanged flow).
    if (sibling.conflicts.length > 0) {
      setConflictFor(sibling);
      return;
    }
    void runMerge(sibling.id, []);
  }

  async function confirmConflict(overrideFields: string[]) {
    const sibling = conflictFor;
    if (!sibling) return;
    setConflictFor(null);
    await runMerge(sibling.id, overrideFields);
  }

  return (
    <>
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
              <div className="px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
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
                    onClick={() => pick(s)}
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
              {editLocked && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="edit-lock-resume"
                  className={MENU_ITEM}
                  disabled={resumingSync}
                  onClick={() => {
                    setOpen(false);
                    void resumeSyncUpdates();
                  }}
                >
                  Resume sync updates
                </button>
              )}
            </>
          )
        }
      </OverflowMenu>

      {conflictFor && (
        <MergeConflictDialog
          conflicts={conflictFor.conflicts}
          keeperLabel={keeperLabel}
          dropLabel={conflictFor.sourceLabel}
          units={units}
          dropSetCount={conflictFor.setCount}
          onConfirm={(overrideFields) => void confirmConflict(overrideFields)}
          onCancel={() => setConflictFor(null)}
        />
      )}
    </>
  );
}
