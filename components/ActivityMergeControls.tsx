"use client";

import { useState, useTransition } from "react";
import { IconGitMerge, IconCopyCheck, IconEyeOff } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";
import type { FieldConflict } from "@/lib/import-review/conflicts";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import {
  mergeActivityPair,
  resolvePair,
} from "@/app/(app)/data/review-actions";

// The action row for one detected ACTIVITY duplicate pair in the Data → Review
// resolver (issue #10), now conflict-aware (issue #100). Either row can be the
// keeper (two merge buttons). When the two rows genuinely disagree on a field, the
// chosen keeper's merge opens the shared conflict preview first so the user picks
// per field; with zero conflicts the merge submits in one click, unchanged. Keep
// both / Dismiss are unchanged plain server-action forms.
//
// Conflicts arrive oriented with row A as the keeper (keepValue = A's value); the
// "keep B" button flips each pair's two values so the dialog always pre-selects the
// active keeper's value.
export default function ActivityMergeControls({
  signature,
  aId,
  bId,
  aLabel,
  bLabel,
  conflicts,
  units,
}: {
  signature: string;
  aId: number;
  bId: number;
  aLabel: string;
  bLabel: string;
  conflicts: FieldConflict[];
  units: UnitPrefs;
}) {
  const [pending, startTransition] = useTransition();
  // The keeper whose merge is awaiting per-field resolution ("a" | "b"), or null.
  const [dialogFor, setDialogFor] = useState<"a" | "b" | null>(null);

  function submitMerge(
    keepId: number,
    dropId: number,
    overrideFields: string[]
  ) {
    const fd = new FormData();
    fd.set("keep_id", String(keepId));
    fd.set("drop_id", String(dropId));
    fd.set("signature", signature);
    if (overrideFields.length > 0)
      fd.set("overrides", JSON.stringify(overrideFields));
    startTransition(() => {
      void mergeActivityPair(fd);
    });
  }

  function onMergeClick(keeper: "a" | "b") {
    if (conflicts.length > 0) {
      setDialogFor(keeper);
      return;
    }
    if (keeper === "a") submitMerge(aId, bId, []);
    else submitMerge(bId, aId, []);
  }

  // Conflicts oriented for the active keeper (flip values when B keeps).
  const dialogConflicts: FieldConflict[] =
    dialogFor === "b"
      ? conflicts.map((c) => ({
          field: c.field,
          keepValue: c.dropValue,
          dropValue: c.keepValue,
        }))
      : conflicts;

  function confirmDialog(overrideFields: string[]) {
    if (dialogFor === "a") submitMerge(aId, bId, overrideFields);
    else if (dialogFor === "b") submitMerge(bId, aId, overrideFields);
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
          conflicts={dialogConflicts}
          keeperLabel={dialogFor === "a" ? aLabel : bLabel}
          dropLabel={dialogFor === "a" ? bLabel : aLabel}
          units={units}
          busy={pending}
          onConfirm={confirmDialog}
          onCancel={() => setDialogFor(null)}
        />
      )}
    </div>
  );
}
