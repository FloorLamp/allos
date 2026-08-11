"use client";

import { useState } from "react";
import Link from "next/link";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import MergeConflictDialog, {
  type ConflictDialogMember,
} from "@/components/MergeConflictDialog";
import { useResumeSyncUpdates } from "@/components/EditLockNotice";
import type { ActivityEditData } from "@/components/ActivityForm";
import type { UnitPrefs } from "@/lib/settings";
import {
  detectClusterFieldConflicts,
  type ClusterFieldConflict,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import type { AppRoute } from "@/lib/hrefs";
import { mergeActivities } from "./activity-actions";

// A same-day sibling this card can absorb: id + label, plus its fold-field values
// (from TrainingLogView's unfiltered scope group) so the shared conflict picker
// (#100/#1431) can be computed for whatever member set + keeper the user assembles.
export interface MergeSibling {
  id: number;
  title: string;
  // Provenance label for the sibling's values ("Manual" / "Strava" / …).
  sourceLabel: string;
  // The sibling's fold-field values (pickFoldValues) — the picker's conflict input.
  foldValues: Record<string, unknown>;
  // How many exercise sets this sibling carries — moved onto the keeper by the merge
  // (#199); surfaced in the conflict preview so the user sees what's moving.
  setCount: number;
}

// A merge awaiting per-field conflict resolution in the shared picker: the chosen
// keeper + drops, the detected conflicts across ALL members, and the labels/set
// count the dialog shows.
interface PendingConflictMerge {
  keepId: number;
  dropIds: number[];
  conflicts: ClusterFieldConflict[];
  members: ConflictDialogMember[];
  movedSetCount: number;
}

// The kebab (⋯) action menu on a Training Log activity card. Its affordances:
//
//  • "View ride details" — read-first navigation for cycling activities.
//  • "Edit" — opens the existing activity editor without making the ride title
//    itself an edit affordance.
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
  foldValues,
  editLocked,
  units,
  detailHref,
  canWrite = true,
}: {
  // The full card activity — the source for "Log again".
  activity: ActivityEditData;
  // The same-day, same-profile activities this one can absorb.
  siblings: MergeSibling[];
  // Provenance label for THIS card's values (its side in a conflict).
  keeperLabel: string;
  // THIS card's fold-field values (pickFoldValues) — the picker's conflict input.
  foldValues: Record<string, unknown>;
  // A hand-edited integration row keeps its compact lock marker in provenance;
  // the deliberate re-enable action lives here rather than lengthening the card.
  editLocked: boolean;
  units: UnitPrefs;
  // Read-first destination for activities with a dedicated detail surface.
  detailHref?: AppRoute | null;
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
  // The merge awaiting per-field conflict resolution in the shared picker
  // (#100/#1431), or null. BOTH flows use it: the quick single-pick (card keeper +
  // one drop) and the multi-select with any chosen keeper.
  const [pendingConflict, setPendingConflict] =
    useState<PendingConflictMerge | null>(null);
  const undoable = useUndoableDelete();
  const { openEdit, openRepeat } = useActivityEditor();
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

  // ONE decision for both merge flows (#1431): assemble the members (this card +
  // the involved siblings), detect the per-field conflicts across ALL of them, and
  // either merge in one click (no conflicts, unchanged) or park the merge behind
  // the shared picker so the user chooses per field.
  function startMerge(keepId: number, siblingMembers: MergeSibling[]) {
    const memberVals = [
      { id: activity.id, values: foldValues },
      ...siblingMembers.map((s) => ({ id: s.id, values: s.foldValues })),
    ];
    const dropIds = memberVals.map((m) => m.id).filter((id) => id !== keepId);
    const conflicts = detectClusterFieldConflicts(memberVals);
    setOpen(false);
    resetPicker();
    if (conflicts.length === 0) {
      void runMerge(keepId, dropIds, {});
      return;
    }
    setPendingConflict({
      keepId,
      dropIds,
      conflicts,
      // Label options by title + provenance: the title matches what the merge
      // picker lists; the provenance says whose measurement a value is.
      members: [
        { id: activity.id, label: `${activity.title} · ${keeperLabel}` },
        ...siblingMembers.map((s) => ({
          id: s.id,
          label: `${s.title} · ${s.sourceLabel}`,
        })),
      ],
      // The training history that will move: every DROP's sets (#199) — including
      // this card's own when a sibling keeper absorbs it.
      movedSetCount: dropIds.reduce(
        (n, id) =>
          n +
          (id === activity.id
            ? (activity.sets?.length ?? 0)
            : (siblingMembers.find((s) => s.id === id)?.setCount ?? 0)),
        0
      ),
    });
  }

  // Quick single-pick (the #64 flow): absorb ONE sibling into THIS card (card keeper).
  function pick(sibling: MergeSibling) {
    startMerge(activity.id, [sibling]);
  }

  async function runMerge(
    keepId: number,
    dropIds: number[],
    choices: OverrideChoices
  ) {
    const fd = new FormData();
    fd.set("keep_id", String(keepId));
    fd.set("drop_ids", JSON.stringify(dropIds));
    // Multi-view (#1330): target the subject's profile so the merge (keeper edit +
    // drop deletes) write-gates on it; absent single-view falls back to acting.
    if (activity.subjectProfileId != null)
      fd.set("profile_id", String(activity.subjectProfileId));
    if (Object.keys(choices).length > 0)
      fd.set("overrides", JSON.stringify(choices));
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
    const includedSiblings = siblings.filter((s) => checked.has(s.id));
    if (includedSiblings.length === 0) return;
    const memberIds = [activity.id, ...includedSiblings.map((s) => s.id)];
    const keep = memberIds.includes(keeperId) ? keeperId : activity.id;
    // The same conflict decision as the quick pick — any member set, any keeper.
    startMerge(keep, includedSiblings);
  }

  async function confirmConflict(choices: OverrideChoices) {
    const merge = pendingConflict;
    if (!merge) return;
    setPendingConflict(null);
    await runMerge(merge.keepId, merge.dropIds, choices);
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
                        className="mt-1 block w-full rounded-sm border border-black/10 bg-white px-1.5 py-1 text-sm text-slate-700 dark:border-white/10 dark:bg-ink-800 dark:text-slate-200"
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
              {detailHref ? (
                <Link
                  href={detailHref}
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => setOpen(false)}
                >
                  View ride details
                </Link>
              ) : null}
              {canWrite && detailHref ? (
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    setOpen(false);
                    openEdit(activity);
                  }}
                >
                  Edit
                </button>
              ) : null}
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

      {pendingConflict && (
        <MergeConflictDialog
          key={pendingConflict.keepId}
          conflicts={pendingConflict.conflicts}
          members={pendingConflict.members}
          keeperId={pendingConflict.keepId}
          units={units}
          movedSetCount={pendingConflict.movedSetCount}
          onConfirm={(choices) => void confirmConflict(choices)}
          onCancel={() => setPendingConflict(null)}
        />
      )}
    </>
  );
}
