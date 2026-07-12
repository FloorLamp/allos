"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WeightUnit } from "@/lib/settings";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { addBodyMetric } from "./body-actions";

// Compact body-metrics quick-add for the Trends "Body" tab (sidebar
// consolidation — this replaces the standalone /body-metrics "Add entry" card).
// Reuses the same addBodyMetric server action + the pure validateBodyMetricInput
// guard the old form used; the inputs lay out inline so the form sits above the
// trend charts without dominating the tab.
export default function BodyQuickAdd({
  weightUnit,
  defaultDate,
  showBodyFat = true,
}: {
  weightUnit: WeightUnit;
  defaultDate: string;
  // #493: the body-fat input is hidden for a growth-tracked profile, matching the
  // charts/history — so "not tracked" is consistent instead of hidden-yet-enterable.
  // Defaults to shown (adult / unknown age).
  showBodyFat?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Opened from a command-palette create action (issue #29): `new=weight` /
  // `new=vitals` scrolls this form into view and focuses the relevant field.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = new URLSearchParams(window.location.search).get("new");
    if (target !== "weight" && target !== "vitals") return;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const id = target === "vitals" ? "bm-resting-hr" : "bm-weight";
    document.getElementById(id)?.focus();
  }, []);

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
    const date = String(formData.get("date") ?? "").trim();
    const str = (k: string) => {
      const v = formData.get(k);
      return v === null || String(v).trim() === "" ? null : String(v);
    };
    // Queue the raw fields (with the current weight unit) to replay on reconnect,
    // landing on the entered date — don't fail the log (issue #28).
    const queueOffline = async () => {
      await enqueue("body-metric", date, {
        weight: String(formData.get("weight") ?? ""),
        weightUnit,
        bodyFatPct: str("body_fat_pct"),
        restingHr: str("resting_hr"),
        notes: str("notes"),
      });
      toast("Saved offline — will sync when you reconnect.");
      formRef.current?.reset();
    };

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline();
      return;
    }
    try {
      await addBodyMetric(formData);
    } catch (err) {
      // Connection dropped mid-submit — queue instead of showing a false failure.
      if (shouldQueueOffline(navigator.onLine !== false, err)) {
        await queueOffline();
        return;
      }
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
        {showBodyFat && (
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
        )}
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
