"use client";

import FindingFollowUpScheduler from "@/components/FindingFollowUpScheduler";
import { trackSkinFollowUp } from "./actions";
import type { SkinLesionFollowUpSummary } from "@/lib/queries";

export default function TrackSkinFollowUpControl({
  recordId,
  offer,
  existing,
}: {
  recordId: number;
  offer: boolean;
  existing?: SkinLesionFollowUpSummary;
}) {
  if (!existing && !offer) return null;
  return (
    <FindingFollowUpScheduler
      action={trackSkinFollowUp}
      existing={existing}
      kind="skin"
      sourceId={recordId}
    />
  );
}
