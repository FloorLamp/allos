"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { discardWorkout } from "../activity-actions";
import { useActivityEditor } from "@/components/ActivityEditorProvider";

// The draft banner's one action (#2870 step 3): remove the never-logged
// session and return to Training or Timeline, whichever is relevant. `if_empty` rides along so a save
// landing between render and tap keeps the row — the server re-checks, and a
// "kept" outcome simply refreshes the page into its real record state.
export default function DiscardDraftButton({
  activityId,
}: {
  activityId: number;
}) {
  const router = useRouter();
  const { trainingRelevant } = useActivityEditor();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid="discard-draft"
      disabled={busy}
      className="btn-ghost text-sm font-medium"
      onClick={async () => {
        setBusy(true);
        try {
          const fd = new FormData();
          fd.set("activity_id", String(activityId));
          fd.set("if_empty", "1");
          const out = await discardWorkout(fd);
          if (out.kind === "discarded")
            router.replace(trainingRelevant ? "/training" : "/timeline");
          else router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      Discard draft
    </button>
  );
}
