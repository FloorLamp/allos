"use client";

import FindingFollowUpScheduler from "@/components/FindingFollowUpScheduler";
import { trackImagingFollowUp } from "./actions";
import type { ImagingFollowUpSummary } from "@/lib/queries";

export default function TrackFollowUpControl({
  studyId,
  existing,
}: {
  studyId: number;
  existing?: ImagingFollowUpSummary;
}) {
  return (
    <FindingFollowUpScheduler
      action={trackImagingFollowUp}
      existing={existing}
      kind="imaging"
      sourceId={studyId}
    />
  );
}
