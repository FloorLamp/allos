"use client";

import Button from "@/components/Button";
import { useDoseDayResolution } from "@/components/medications/dose-day-settlement";
import { bulkLabel, namesPhrase } from "@/lib/usual-routine";

// THE WHOLE SLOT IN ONE TAP, ON THE DASHBOARD'S SLOT ROW (#5063).
//
// It mints nothing. The write is `useDoseDayResolution` — the one dated-dose bulk
// owner (#4316) that the quick sheet's whole-stack row and the day ledger's take-all
// both post through — so a slot taken here writes exactly the doses that stack tap
// writes, off the same server-side re-derivation of what the day still owes. The
// words are `bulkLabel`, the ruled bulk verb over a dose set (#4477), and the
// composition is the ledger's take-all unchanged; only the row around it is new.
//
// NO LOCAL SETTLEMENT STATE. The row is server-rendered and `resolveDayDoses`
// revalidates `/`, so what was written leaves with the next render, and a refusal is
// named in the toast the shared settlement already writes — a dashboard row has no
// per-dose note line to put one in, and adding one here would be a second answer to a
// question `settleDayDoses` already answers.
export default function DoseSlotTakeAll({
  date,
  doses,
  profileId,
}: {
  date: string;
  doses: readonly { doseId: number; name: string }[];
  profileId?: number;
}) {
  const ids = doses.map((dose) => dose.doseId);
  const { resolveAll, bulkBlocked } = useDoseDayResolution({
    date,
    bulkFailureMessage: "Something went wrong — reload to see what was logged.",
    note: () => {},
    resolved: () => {},
    profileId,
  });
  return (
    <Button
      data-testid="dashboard-dose-slot-takeall"
      // The visible words are the count; the reader gets the names the tap will
      // write, in the shared phrase both other take-alls promise with.
      aria-label={`${bulkLabel("Take", doses)}: ${namesPhrase(doses.map((dose) => dose.name))}`}
      disabled={bulkBlocked(ids)}
      onClick={() => resolveAll(ids)}
    >
      {bulkLabel("Take", doses)}
    </Button>
  );
}
