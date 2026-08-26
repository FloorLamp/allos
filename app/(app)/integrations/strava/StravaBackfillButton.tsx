"use client";

import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import { INTEGRATION_BACKFILL_STARTED_EVENT } from "@/components/integrations/IntegrationBackfillProgress";
import { backfillStravaRideDetails } from "./actions";

export default function StravaBackfillButton({ missing }: { missing: number }) {
  async function backfill() {
    const result = await backfillStravaRideDetails();
    if (result.status === "done") {
      window.dispatchEvent(new Event(INTEGRATION_BACKFILL_STARTED_EVENT));
    }
    return result;
  }

  return (
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
  );
}
