"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmNiggle } from "../../niggle-actions";

// The one-tap confirm chip (issue #2948, part 2). The detector found a body region in
// this activity's notes; the chip ASKS, and the tap is the only thing that writes
// (#798 confirm-never-silent).
//
// Deliberately not a modal and not a banner: it sits under the note it came from, it
// never blocks logging, and its copy is a question that says nothing has been recorded.
// A refusal is shown as-is rather than swallowed — a chip that quietly does nothing is
// the failure mode the confirm posture exists to avoid.
export default function NiggleConfirmChip({
  activityId,
  region,
  laterality,
  prompt,
  subjectProfileId,
}: {
  activityId: number;
  region: string;
  laterality: "left" | "right" | "bilateral" | null;
  prompt: string;
  subjectProfileId?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 text-sm"
      data-testid="niggle-chip"
      data-region={region}
      data-laterality={laterality ?? "unstated"}
    >
      <span className="text-slate-600 dark:text-slate-300">{prompt}</span>
      <button
        type="button"
        data-testid="niggle-chip-confirm"
        disabled={busy}
        className="btn btn-sm"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const fd = new FormData();
            fd.set("activity_id", String(activityId));
            fd.set("region", region);
            if (laterality) fd.set("laterality", laterality);
            if (subjectProfileId != null)
              fd.set("profile_id", String(subjectProfileId));
            const out = await confirmNiggle(fd);
            if (out.ok) router.refresh();
            else
              setError(
                out.reason === "no-candidate"
                  ? "That note has changed — reload to see what it says now."
                  : "Couldn’t track that — reload and try again."
              );
          } finally {
            setBusy(false);
          }
        }}
      >
        Track it
      </button>
      {error ? (
        <span
          className="text-rose-600 dark:text-rose-400"
          data-testid="niggle-chip-error"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
