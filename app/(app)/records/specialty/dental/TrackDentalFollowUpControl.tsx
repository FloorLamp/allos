"use client";

import FindingFollowUpScheduler from "@/components/FindingFollowUpScheduler";
import { trackDentalFollowUp } from "./actions";
import type { DentalFollowUpSummary } from "@/lib/queries";

export default function TrackDentalFollowUpControl({
  recordId,
  offer,
  existing,
}: {
  recordId: number;
  offer: boolean;
  existing?: DentalFollowUpSummary;
}) {
  if (!existing && !offer) return null;
  return (
    <FindingFollowUpScheduler
      action={trackDentalFollowUp}
      existing={existing}
      kind="dental"
      sourceId={recordId}
    />
  );
}
