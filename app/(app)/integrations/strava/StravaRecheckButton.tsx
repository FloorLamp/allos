"use client";

import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import { recheckStravaEmptySessions } from "./actions";

export default function StravaRecheckButton({
  answeredNone,
}: {
  answeredNone: number;
}) {
  if (answeredNone === 0) return null;
  return (
    <IntegrationActionButton
      binding={{
        action: recheckStravaEmptySessions,
        label: "Re-check sessions with no details",
        pendingLabel: "Re-checking…",
        icon: "refresh",
        testId: "strava-recheck-empty",
        count: answeredNone,
      }}
    />
  );
}
