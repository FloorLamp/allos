"use client";

import { useMemo, useState, useTransition } from "react";
import type { UnitPrefs } from "@/lib/settings";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";
import {
  detectClusterFieldConflicts,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import DuplicateResolutionActions from "@/components/DuplicateResolutionActions";
import {
  mergeActivityPair,
  resolvePair,
} from "@/app/(app)/data/review-actions";

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
  aFoldValues: Record<string, unknown>;
  bFoldValues: Record<string, unknown>;
  units: UnitPrefs;
}) {
  const [pending, startTransition] = useTransition();
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

  const resolutionPayload = (decision: "kept-both" | "dismissed") => ({
    domain: ACTIVITY_DOMAIN,
    decision,
    signature,
  });

  return (
    <>
      <DuplicateResolutionActions
        pending={pending}
        actions={[
          ["keeper", aLabel, () => onMergeClick("a")],
          ["alternate-keeper", bLabel, () => onMergeClick("b")],
          ["keep-both", null, resolvePair, resolutionPayload("kept-both")],
          ["dismiss", null, resolvePair, resolutionPayload("dismissed")],
        ]}
      />

      {dialogFor && (
        <MergeConflictDialog
          key={dialogFor === "a" ? aId : bId}
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
    </>
  );
}
