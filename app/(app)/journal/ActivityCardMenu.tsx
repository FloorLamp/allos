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
  canWrite = true,
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
  // Whether the acting login may write to THIS card's subject profile (issue #1330).
  // Merge (edits the keeper + deletes the sibling) and resume-sync (clears the edit
  // lock) are subject-writes, so they're hidden on a read-only-granted member's card.
  // "Log again" survives regardless — it CREATES on the acting profile, never the
  // subject, so repeating a read-only member's workout logs it as yours.
  canWrite?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // Multi-select mode (#1081). The picker DEFAULTS to the quick single-pick list (this
  // card keeper, one sibling — the #64 flow); a toggle reveals the full keeper-radio
  // multi-select across all members. Kept as an opt-in mode so the quick path (and its
  // browser tests) stay a single click.
  const [multiMode, setMultiMode] = useState(false);
  // Multi-select state: the sibling ids checked to absorb, and the chosen keeper across
  // ALL members (this card + checked siblings). Default keeper = card.
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [keeperId, setKeeperId] = useState<number>(activity.id);
  // The sibling whose merge is awaiting per-field conflict resolution, or null. Only
  // the pairwise case (card keeper + one drop) opens the #100 dialog; the N-way
  // multi-value picker is a fast-follow, so a 3+ merge is keeper-wins gap-fill.
  const [conflictFor, setConflictFor] = useState<MergeSibling | null>(null);
  const undoable = useUndoableDelete();
  const { openRepeat } = useActivityEditor();
  const { busy: resumingSync, resumeSyncUpdates } = useResumeSyncUpdates(
    "activities",
    activity.id
  );

  function resetPicker() {
    setPicking(false);
    setMultiMode(false);
    setChecked(new Set());
    setKeeperId(activity.id);
  }

  // Quick single-pick (the #64 flow): absorb ONE sibling into THIS card (card keeper),
  // opening the #100 conflict preview first when the two rows disagree.
  function pick(sibling: MergeSibling) {
    setOpen(false);
    resetPicker();
    if (sibling.conflicts.length > 0) {
      setConflictFor(sibling);
      return;
    }
    void runMerge(activity.id, [sibling.id], []);
  }

  async function runMerge(
    keepId: number,
    dropIds: number[],
    overrideFields: string[]
  ) {
    const fd = new FormData();
    fd.set("keep_id", String(keepId));
    fd.set("drop_ids", JSON.stringify(dropIds));
    // Multi-view (#1330): target the subject's profile so the merge (keeper edit +
    // drop deletes) write-gates on it; absent single-view falls back to acting.
    if (activity.subjectProfileId != null)
      fd.set("profile_id", String(activity.subjectProfileId));
    if (overrideFields.length > 0)
      fd.set("overrides", JSON.stringify(overrideFields));
    await undoable(mergeActivities, fd, {
      deletedMessage: "Activities merged.",
    });
  }

  // Toggle a sibling's inclusion; unchecking the current keeper falls back to the card.
  function toggleChecked(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (keeperId === id) setKeeperId(activity.id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Choosing a sibling as keeper also includes it in the merge.
  function chooseKeeper(id: number) {
    setKeeperId(id);
    if (id !== activity.id) setChecked((prev) => new Set(prev).add(id));
  }

  function runPickerMerge() {
    const includedSiblingIds = siblings
      .filter((s) => checked.has(s.id))
      .map((s) => s.id);
    if (includedSiblingIds.length === 0) return;
    const memberIds = [activity.id, ...includedSiblingIds];
    const keep = memberIds.includes(keeperId) ? keeperId : activity.id;
    const dropIds = memberIds.filter((id) => id !== keep);
    // Pairwise + card keeper + a genuinely-conflicting drop → open the #100 preview;
    // every other shape (multi-select, or a chosen-away card) merges keeper-wins.
    if (keep === activity.id && dropIds.length === 1) {
      const sib = siblings.find((s) => s.id === dropIds[0]);
      if (sib && sib.conflicts.length > 0) {
        setOpen(false);
        setConflictFor(sib);
        return;
      }
    }
    setOpen(false);
    resetPicker();
    void runMerge(keep, dropIds, []);
  }

  async function confirmConflict(overrideFields: string[]) {
    const sibling = conflictFor;
    if (!sibling) return;
    setConflictFor(null);
    resetPicker();
    await runMerge(activity.id, [sibling.id], overrideFields);
  }

  return (
    <>
      <OverflowMenu
        label="Activity actions"
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetPicker();
        }}
      >
        {() =>
          picking ? (
            <div data-testid="merge-picker">
              {!multiMode ? (
                <>
                  {/* Quick single-pick list (#64): click a sibling to absorb it into
                      THIS card. Unchanged one-click flow. */}
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
                  <button
                    type="button"
                    data-testid="merge-multi-toggle"
                    className={`${MENU_ITEM} font-medium text-brand-600 dark:text-brand-400`}
                    onClick={() => setMultiMode(true)}
                  >
                    Combine several / choose keeper…
                  </button>
                </>
              ) : (
                <>
                  {/* Multi-select (#1081): check what to combine, then choose the
                      keeper across ALL members (this card + siblings) from the select.
                      A native <select> (not a radio group) is the keeper control — it's
                      one reliable value with no per-row control interplay. */}
                  <div className="px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                    Combine — check duplicates, then choose the keeper
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    {siblings.map((s) => (
                      <div
                        key={s.id}
                        data-testid="merge-target"
                        className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200"
                        title={s.title}
                      >
                        <input
                          type="checkbox"
                          data-testid="merge-target-check"
                          checked={checked.has(s.id)}
                          onChange={() => toggleChecked(s.id)}
                          aria-label={`Combine ${s.title}`}
                        />
                        <span className="truncate">{s.title}</span>
                      </div>
                    ))}
                  </div>
                  <div className="px-3 py-1.5">
                    <label className="text-xs text-slate-500 dark:text-slate-400">
                      Keep
                      <select
                        data-testid="merge-keeper-select"
                        value={keeperId}
                        onChange={(e) => chooseKeeper(Number(e.target.value))}
                        className="mt-1 block w-full rounded border border-black/10 bg-white px-1.5 py-1 text-sm text-slate-700 dark:border-white/10 dark:bg-ink-800 dark:text-slate-200"
                      >
                        <option value={activity.id}>
                          {activity.title} (this)
                        </option>
                        {siblings.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    data-testid="merge-run"
                    disabled={checked.size === 0}
                    className={`${MENU_ITEM} font-medium text-brand-600 disabled:opacity-40 dark:text-brand-400`}
                    onClick={runPickerMerge}
                  >
                    Merge {checked.size + 1} activities
                  </button>
                </>
              )}
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
              {canWrite && siblings.length > 0 && (
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
              {canWrite && editLocked && (
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
