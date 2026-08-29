"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useRef, useState } from "react";
import type { WeightUnit } from "@/lib/settings";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { subjectActionLabel } from "@/lib/own-profile";
import InlineError from "@/components/InlineError";

// Inline weight quick-add for the dashboard weight presentation (#1042 phase 2).
// Manual daily weighers had the app's highest-frequency action at its deepest
// path (Trends → Overview → body census → quick-add); this is the SAME write, promoted — one
// computation, two entry points (#221): it posts the SAME addBodyMetric server
// action as the Trends → Overview → body census quick-add (requireWriteAccess → canonical-kg
// conversion via the login's unit pref inside lib/offline/writes.ts::
// insertBodyMetric), runs the SAME pure validateBodyMetricInput guard, and rides
// the SAME "body-metric" offline quick-log queue (issue #28) when the network is
// out, so a gym-scale weigh-in never fails. Weight-only on purpose — body fat /
// resting HR / notes stay on the Trends form this atom links to.
export default function WeightQuickAdd({
  weightUnit,
  today,
  subjectName,
}: {
  weightUnit: WeightUnit;
  // The active profile's current date (server-resolved in its timezone) — the
  // quick-add always logs "today", like a scale would.
  today: string;
  // Not-self subject name (issue #1013): when the login is acting as someone other
  // than its own profile, the label names them ("Log — Mia", "Log today's weight for
  // Mia") so a caregiver's weigh-in never lands on the wrong record. Null → plain.
  subjectName: string | null;
}) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  // Which dashboard region this weigh-in widget sits in (#3087).
  const stampLoggedVia = useLoggedViaStamp();
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
    // Trends → Overview → body census quick-add so the one replay path serves both).
    const queueOffline = async () => {
      const kept =
        (await enqueue("body-metric", today, {
          weight: String(formData.get("weight") ?? ""),
          weightUnit,
          bodyFatPct: null,
          restingHr: null,
          notes: null,
        })) === "kept";
      // The device can refuse the capture (#3038) — nothing was queued, so say
      // so and skip the success toast. (The fields clear either way: React
      // resets a form after its action, refused or not.)
      if (!kept) {
        toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
        return;
      }
      toast("Saved offline — will sync when you reconnect.");
      formRef.current?.reset();
    };

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline();
      return;
    }
    try {
      // The same action the Trends page's add form posts (#3087), which is exactly
      // why the surface has to ride the post rather than be inferred server-side.
      // The value comes from the region this widget is mounted in rather than being
      // asserted here: the dashboard declares itself once, for every control on it.
      await addBodyMetric(stampLoggedVia(formData));
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
  }

  return (
    <form ref={formRef} action={handle} className="mt-4 space-y-1">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="dash-weight">
            {subjectName
              ? `Log today's weight for ${subjectName} (${weightUnit})`
              : `Log today's weight (${weightUnit})`}
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
        {/* The unit CAPTURED with the number (#630, #2863) — the same one the label
            above prints, so the write cannot read it differently from the person who
            typed it. The action's fallback, the pref re-read at write time, can: a
            dashboard rendered before a Settings flip submits after it. */}
        <input type="hidden" name="weight_unit" value={weightUnit} />
        <SubmitButton
          data-testid="weight-quick-add-save"
          pendingLabel="Saving…"
        >
          {subjectActionLabel("Log", subjectName)}
        </SubmitButton>
      </div>
      <InlineError>{error}</InlineError>
    </form>
  );
}
