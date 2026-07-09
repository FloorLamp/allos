"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WeightUnit } from "@/lib/settings";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { addBodyMetric } from "./body-actions";

// Compact body-metrics quick-add for the Trends "Body" tab (sidebar
// consolidation — this replaces the standalone /body-metrics "Add entry" card).
// Reuses the same addBodyMetric server action + the pure validateBodyMetricInput
// guard the old form used; the inputs lay out inline so the form sits above the
// trend charts without dominating the tab.
export default function BodyQuickAdd({
  weightUnit,
  defaultDate,
}: {
  weightUnit: WeightUnit;
  defaultDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    // The server action silently skips out-of-range/non-finite numbers, which
    // would otherwise show a false "Entry saved" toast. Validate here first so
    // the user gets inline feedback and the input stays put.
    const rangeError = validateBodyMetricInput({
      weight: formData.get("weight") as string | null,
      bodyFatPct: formData.get("body_fat_pct") as string | null,
      restingHr: formData.get("resting_hr") as string | null,
    });
    if (rangeError) {
      setError(rangeError);
      return;
    }
    try {
      await addBodyMetric(formData);
    } catch {
      setError("Couldn't save this entry. Please try again.");
      return;
    }
    toast("Entry saved");
    formRef.current?.reset();
    router.refresh();
  }

  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Log body metrics
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className="label" htmlFor="bm-date">
            Date
          </label>
          <DateField
            id="bm-date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="bm-weight">
            Weight ({weightUnit})
          </label>
          <input
            id="bm-weight"
            type="number"
            step="0.1"
            min="0"
            name="weight"
            className="input"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="bm-body-fat">
            Body fat (%)
          </label>
          <input
            id="bm-body-fat"
            type="number"
            step="0.1"
            min="0"
            max="100"
            name="body_fat_pct"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="bm-resting-hr">
            Resting HR (bpm)
          </label>
          <input
            id="bm-resting-hr"
            type="number"
            min="0"
            name="resting_hr"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="bm-notes">
            Notes
          </label>
          <input id="bm-notes" name="notes" className="input" />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <SubmitButton pendingLabel="Saving…">Save entry</SubmitButton>
    </form>
  );
}
