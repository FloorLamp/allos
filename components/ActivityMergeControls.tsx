"use client";

import { useMemo, useState, useTransition } from "react";
import { IconGitMerge, IconCopyCheck, IconEyeOff } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";
import {
  detectClusterFieldConflicts,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import {
  mergeActivityPair,
  resolvePair,
} from "@/app/(app)/data/review-actions";

// The action row for one detected ACTIVITY duplicate pair in the Data → Review
// resolver (issue #10), conflict-aware (issue #100). Either row can be the keeper
// (two merge buttons). When the two rows genuinely disagree on a field, the chosen
// keeper's merge opens the SHARED conflict picker first so the user picks per
// field; with zero conflicts the merge submits in one click, unchanged. Keep both /
// Dismiss are unchanged plain server-action forms.
//
// The picker is the same N-way component every merge surface uses (#1431); this
// pairwise card is simply its two-member case, oriented by the pressed button's
// keeper (the picker pre-selects the keeper's values itself).
export default function ActivityMergeControls({
  signature,
  aId,
  bId,
  aLabel,
  bLabel,
  aFoldValues,
  bFoldValues,
  units,
}: {
  signature: string;
  aId: number;
  bId: number;
  aLabel: string;
  bLabel: string;
  // Both rows' fold-field values (pickFoldValues) — the picker's conflict input.
  aFoldValues: Record<string, unknown>;
  bFoldValues: Record<string, unknown>;
  units: UnitPrefs;
}) {
  const [pending, startTransition] = useTransition();
  // The keeper whose merge is awaiting per-field resolution ("a" | "b"), or null.
  const [dialogFor, setDialogFor] = useState<"a" | "b" | null>(null);

  const conflicts = useMemo(
    () =>
      detectClusterFieldConflicts([
        { id: aId, values: aFoldValues },
        { id: bId, values: bFoldValues },
      ]),
    [aId, bId, aFoldValues, bFoldValues]
  );

  function submitMerge(
    keepId: number,
    dropId: number,
    choices: OverrideChoices
  ) {
    const fd = new FormData();
    fd.set("keep_id", String(keepId));
    fd.set("drop_id", String(dropId));
    fd.set("signature", signature);
    if (Object.keys(choices).length > 0)
      fd.set("overrides", JSON.stringify(choices));
    startTransition(() => {
      void mergeActivityPair(fd);
    });
  }

  function onMergeClick(keeper: "a" | "b") {
    if (conflicts.length > 0) {
      setDialogFor(keeper);
      return;
    }
    if (keeper === "a") submitMerge(aId, bId, {});
    else submitMerge(bId, aId, {});
  }

  function confirmDialog(choices: OverrideChoices) {
    if (dialogFor === "a") submitMerge(aId, bId, choices);
    else if (dialogFor === "b") submitMerge(bId, aId, choices);
    setDialogFor(null);
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onMergeClick("a")}
        disabled={pending}
        data-testid="dup-merge-primary"
        className="btn btn-sm"
      >
        <IconGitMerge className="h-4 w-4" stroke={1.75} />
        Merge, keep {aLabel}
      </button>
      <button
        type="button"
        onClick={() => onMergeClick("b")}
        disabled={pending}
        data-testid="dup-merge-secondary"
        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
      >
        Keep {bLabel} instead
      </button>
      <form action={resolvePair}>
        <input type="hidden" name="domain" value={ACTIVITY_DOMAIN} />
        <input type="hidden" name="decision" value="kept-both" />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconCopyCheck className="h-4 w-4" stroke={1.75} />
          Keep both
        </button>
      </form>
      <form action={resolvePair}>
        <input type="hidden" name="domain" value={ACTIVITY_DOMAIN} />
        <input type="hidden" name="decision" value="dismissed" />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750"
        >
          <IconEyeOff className="h-4 w-4" stroke={1.75} />
          Dismiss
        </button>
      </form>

      {dialogFor && (
        <MergeConflictDialog
          conflicts={conflicts}
          members={[
            { id: aId, label: aLabel },
            { id: bId, label: bLabel },
          ]}
          keeperId={dialogFor === "a" ? aId : bId}
          units={units}
          busy={pending}
          onConfirm={confirmDialog}
          onCancel={() => setDialogFor(null)}
        />
      )}
    </div>
  );
}
