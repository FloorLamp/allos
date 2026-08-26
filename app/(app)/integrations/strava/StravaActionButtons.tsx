"use client";

import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import { INTEGRATION_BACKFILL_STARTED_EVENT } from "@/components/integrations/IntegrationBackfillProgress";
import {
  backfillStravaRideDetails,
  recheckStravaEmptySessions,
} from "./actions";

export default function StravaActionButtons({
  missing,
  answeredNone,
}: {
  missing: number;
  answeredNone: number;
}) {
  async function backfill() {
    const result = await backfillStravaRideDetails();
    if (result.status === "done") {
      window.dispatchEvent(new Event(INTEGRATION_BACKFILL_STARTED_EVENT));
    }
    return result;
  }

  return (
    <>
      <IntegrationActionButton
        binding={{
          action: backfill,
          label: "Backfill session details",
          pendingLabel: "Backfilling…",
          icon: "import",
          testId: "strava-backfill-details",
          count: missing,
        }}
      />
      {answeredNone > 0 && (
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
      )}
    </>
  );
}
