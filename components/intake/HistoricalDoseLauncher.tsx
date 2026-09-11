"use client";

import { useState } from "react";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import type { DoseScheduleVersion } from "@/lib/intake-cadence";
import { logHeading } from "@/lib/log-manifest";

export interface HistoricalDoseLauncherItem {
  id: number;
  name: string;
  product: string | null;
  asNeeded: boolean;
  doses: {
    id: number;
    amount: string | null;
    timeOfDay: string | null;
    versions?: readonly DoseScheduleVersion[];
  }[];
}

// Top-level destination for a day-history dose backfill (#2420). The write, the item
// choice and the field set are all the shared `HistoricalDoseForm`'s (#4424 ruling 2);
// what is left here is the card this page puts around it and its two empty states.
export default function HistoricalDoseLauncher({
  items,
  initialDate,
  maxDate,
  defaultTime,
  invalidRequestedDate = false,
}: {
  items: HistoricalDoseLauncherItem[];
  initialDate?: string;
  maxDate: string;
  defaultTime: string;
  invalidRequestedDate?: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section
      className="card section-seam mb-6"
      data-testid="historical-dose-launcher"
      aria-labelledby="historical-dose-launcher-title"
    >
      {/* THE DOMAIN'S ONE PHRASE, READ FROM THE DECLARATION (#5300 rule 6, #5617
          step 2). This page said "Log a past dose" — an article plus a noun that
          carries its own verb-sense — while the record's door and the quick sheet
          had already converged on the manifest's `Log <noun>`. Rule 6 asks for the
          same noun on the trigger, the sheet, the history door and the dialog; a
          top-level backfill destination is one more of those surfaces, and the day
          it stands on is the page's (the `?backfill=` date), not the heading's. */}
      <h2
        id="historical-dose-launcher-title"
        className="font-semibold text-slate-800 dark:text-slate-100"
      >
        {logHeading("dose")}
      </h2>
      {invalidRequestedDate ? (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
          A historical dose can use any past date, but not a future date.
        </p>
      ) : items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Add an active supplement dose before logging dose history.
        </p>
      ) : open ? (
        <HistoricalDoseForm
          items={items.map((item) => ({
            id: item.id,
            name: item.name,
            asNeeded: item.asNeeded,
            // A supplement keeps no medication courses, so its backfill reaches any
            // past date — the rule this page's items all share.
            courseBound: false,
            doses: item.doses.map((dose) => ({
              id: dose.id,
              amount: dose.amount,
              time_of_day: dose.timeOfDay,
              product: item.product,
              versions: dose.versions,
            })),
          }))}
          initialDate={initialDate}
          maxDate={maxDate}
          defaultTime={defaultTime}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}
