"use client";

import FindingFollowUpScheduler from "@/components/FindingFollowUpScheduler";
import type { ReadingFollowUpSummary } from "@/lib/queries";
import { trackLabFollowUp, trackIopFollowUp } from "./followup-actions";

export default function TrackReadingFollowUpControl({
  recordId,
  existing,
  kind = "lab",
}: {
  recordId: number;
  existing?: ReadingFollowUpSummary;
  kind?: "lab" | "iop";
}) {
  return (
    <FindingFollowUpScheduler
      action={kind === "lab" ? trackLabFollowUp : trackIopFollowUp}
      existing={existing}
      kind={kind}
      sourceId={recordId}
    />
  );
}
