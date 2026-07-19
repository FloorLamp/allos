"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WeightUnit } from "@/lib/settings";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";

// Inline weight quick-add for the dashboard weight-trend widget (#1042 phase 2).
// Manual daily weighers had the app's highest-frequency action at its deepest
// path (Trends → Body → quick-add); this is the SAME write, promoted — one
// computation, two entry points (#221): it posts the SAME addBodyMetric server
// action as the Trends → Body quick-add (requireWriteAccess → canonical-kg
// conversion via the login's unit pref inside lib/offline/writes.ts::
// insertBodyMetric), runs the SAME pure validateBodyMetricInput guard, and rides
// the SAME "body-metric" offline quick-log queue (issue #28) when the network is
// out, so a gym-scale weigh-in never fails. Weight-only on purpose — body fat /
// resting HR / notes stay on the Trends form this widget links to.
export default function WeightQuickAdd({
  weightUnit,
  today,
}: {
  weightUnit: WeightUnit;
  // The active profile's current date (server-resolved in its timezone) — the
  // quick-add always logs "today", like a scale would.
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    // Mirror the Trends quick-add: the server action silently skips out-of-range
    // numbers, so validate up front for inline feedback instead of a false toast.
    const rangeError = validateBodyMetricInput({
      weight: formData.get("weight") as string | null,
      bodyFatPct: null,
      restingHr: null,
    });
    if (rangeError) {
      setError(rangeError);
      return;
    }
    // Queue the raw fields (with the current weight unit) to replay on
    // reconnect — don't fail the log (issue #28; same payload shape as the
    // Trends → Body quick-add so the one replay path serves both).
    const queueOffline = async () => {
      await enqueue("body-metric", today, {
        weight: String(formData.get("weight") ?? ""),
        weightUnit,
        bodyFatPct: null,
        restingHr: null,
        notes: null,
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
      // Connection dropped mid-submit — queue instead of a false failure.
      if (shouldQueueOffline(navigator.onLine !== false, err)) {
        await queueOffline();
        return;
      }
      setError("Couldn't save this weigh-in. Try again.");
      return;
    }
    toast("Entry saved");
    formRef.current?.reset();
    router.refresh();
  }

  return (
    <form ref={formRef} action={handle} className="mt-4 space-y-1">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="dash-weight">
            Log today&apos;s weight ({weightUnit})
          </label>
          <input
            id="dash-weight"
            data-testid="weight-quick-add-input"
            type="number"
            step="0.1"
            min="0"
            name="weight"
            className="input"
            required
          />
        </div>
        <input type="hidden" name="date" value={today} />
        <SubmitButton
          data-testid="weight-quick-add-save"
          pendingLabel="Saving…"
        >
          Log
        </SubmitButton>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </form>
  );
}
