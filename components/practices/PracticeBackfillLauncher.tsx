"use client";

import { useState } from "react";
import LogPracticeButton from "@/components/practices/LogPracticeButton";

export interface PracticeBackfillItem {
  name: string;
  todayCount: number;
  atCeiling: boolean;
  defaultDurationMin: number | null;
}

// A selected calendar day identifies WHEN, but not WHICH practice. This small
// top-level chooser resolves that missing identity and then opens the same
// detailed logger each practice card uses (#2420).
export default function PracticeBackfillLauncher({
  items,
  today,
  initialDate,
  minDate,
  invalidRequestedDate = false,
}: {
  items: PracticeBackfillItem[];
  today: string;
  initialDate?: string;
  minDate: string;
  invalidRequestedDate?: boolean;
}) {
  const [name, setName] = useState(items[0]?.name ?? "");
  const item = items.find((candidate) => candidate.name === name) ?? items[0];

  return (
    <section
      className="card mb-6"
      data-testid="practice-backfill-launcher"
      aria-labelledby="practice-backfill-title"
    >
      <h2
        id="practice-backfill-title"
        className="font-semibold text-slate-800 dark:text-slate-100"
      >
        Log a past practice
      </h2>
      {invalidRequestedDate ? (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
          Practice backfill is available for the previous 30 days.
        </p>
      ) : items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Add a practice before logging a session.
        </p>
      ) : (
        <>
          <label className="mt-3 block text-sm font-medium text-slate-700 dark:text-slate-200">
            Practice
            <select
              className="input mt-1 w-full sm:max-w-sm"
              value={item?.name ?? ""}
              onChange={(event) => setName(event.target.value)}
              data-testid="practice-backfill-picker"
            >
              {items.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          {item && initialDate ? (
            <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
              <LogPracticeButton
                key={item.name}
                practice={item.name}
                todayCount={item.todayCount}
                atCeiling={item.atCeiling}
                today={today}
                defaultDurationMin={item.defaultDurationMin}
                compact
                showDetails
                defaultDetailsOpen
                initialDetailsDate={initialDate}
                detailsMinDate={minDate}
                detailsMaxDate={today}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
