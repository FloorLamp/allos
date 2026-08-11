"use client";

import { useState } from "react";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatMedicationDoseLine } from "@/lib/medication-dose-format";

export interface HistoricalDoseLauncherItem {
  id: number;
  name: string;
  product: string | null;
  asNeeded: boolean;
  doses: {
    id: number;
    amount: string | null;
    timeOfDay: string | null;
  }[];
}

// Top-level destination for a day-history dose backfill (#2420). Choosing the
// item is explicit because the chart's selected day has no single item identity;
// the actual write remains the shared HistoricalDoseForm used by every item row.
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
  const formatPrefs = useFormatPrefs();
  const [itemId, setItemId] = useState(items[0]?.id ?? 0);
  const [open, setOpen] = useState(true);
  const item = items.find((candidate) => candidate.id === itemId) ?? items[0];

  return (
    <section
      className="card mb-6"
      data-testid="historical-dose-launcher"
      aria-labelledby="historical-dose-launcher-title"
    >
      <h2
        id="historical-dose-launcher-title"
        className="font-semibold text-slate-800 dark:text-slate-100"
      >
        Log a past dose
      </h2>
      {invalidRequestedDate ? (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
          A historical dose can use any past date, but not a future date.
        </p>
      ) : items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Add an active supplement dose before logging dose history.
        </p>
      ) : (
        <>
          <label className="mt-3 block text-sm font-medium text-slate-700 dark:text-slate-200">
            IntakeItem
            <select
              className="input mt-1 w-full sm:max-w-sm"
              value={item?.id ?? 0}
              onChange={(event) => {
                setItemId(Number(event.target.value));
                setOpen(true);
              }}
              data-testid="historical-dose-item-picker"
            >
              {items.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          {item && open ? (
            <HistoricalDoseForm
              key={item.id}
              itemId={item.id}
              itemName={item.name}
              doses={item.doses.map((dose) => ({
                id: dose.id,
                amount: dose.amount,
                label:
                  formatMedicationDoseLine({
                    amount: dose.amount,
                    product: item.product,
                    timeOfDay: dose.timeOfDay,
                    asNeeded: item.asNeeded,
                    timeFormat: formatPrefs.timeFormat,
                  }) || "Dose",
              }))}
              initialDate={initialDate}
              maxDate={maxDate}
              defaultTime={defaultTime}
              asNeeded={item.asNeeded}
              courseBound={false}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
