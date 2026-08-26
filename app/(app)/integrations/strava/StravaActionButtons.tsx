"use client";

import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import { INTEGRATION_BACKFILL_STARTED_EVENT as BACKFILL_STARTED } from "@/components/integrations/IntegrationBackfillProgress";
import {
  backfillStravaRideDetails,
  recheckStravaEmptySessions,
} from "./actions";

type Props = { missing: number; answeredNone: number };

export default function StravaActionButtons({ missing, answeredNone }: Props) {
  async function backfill() {
    const result = await backfillStravaRideDetails();
    if (result.status === "done")
      window.dispatchEvent(new Event(BACKFILL_STARTED));
    return result;
  }

  return (
    <>
      <IntegrationActionButton
        binding={{
          action: backfill,
          copy: ["Backfill session details", "Backfilling…"],
          control: { icon: "import", testId: "strava-backfill-details" },
          count: missing,
        }}
      />
      {answeredNone > 0 && (
        <IntegrationActionButton
          binding={{
            action: recheckStravaEmptySessions,
            copy: ["Re-check sessions with no details", "Re-checking…"],
            control: { icon: "refresh", testId: "strava-recheck-empty" },
            count: answeredNone,
          }}
        />
      )}
    </>
  );
}
