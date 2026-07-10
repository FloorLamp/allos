"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { validateVitalsInput } from "@/lib/vitals-input";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { addVitals } from "./vitals-actions";

// Manual "Log vitals" quick-add (issue #16) — a sibling of BodyQuickAdd on the
// Trends "Body" surface for the vitals that previously could ONLY arrive via the
// Health Connect exporter: blood pressure, glucose, SpO2, temperature, sleep, and
// HRV. Every field is optional (log just the ones you measured); at least one is
// required. The server action writes to the SAME tables/metric keys the integration
// uses, so entries share the biomarker table + Body charts + reference-range flags.
// Temperature (°C/°F) and glucose (mg/dL / mmol/L) carry an explicit unit selector
// defaulting to the canonical/display unit; the pure validateVitalsInput mirrors the
// action's bounds so the form surfaces an inline error instead of a false "saved".
export default function VitalsQuickAdd({
  defaultDate,
}: {
  defaultDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    const s = (k: string) => {
      const v = formData.get(k);
      return v === null || String(v).trim() === "" ? null : String(v);
    };
    const raw = {
      systolic: s("systolic"),
      diastolic: s("diastolic"),
      glucose: s("glucose"),
      glucoseUnit: s("glucose_unit"),
      spo2: s("spo2"),
      temperature: s("temperature"),
      tempUnit: s("temp_unit"),
      sleepHours: s("sleep_hours"),
      hrv: s("hrv"),
      gripStrength: s("grip_strength"),
      chairStand: s("chair_stand"),
      balance: s("balance"),
    };
    const validationError = validateVitalsInput(raw);
    if (validationError) {
      setError(validationError);
      return;
    }
    const date = String(formData.get("date") ?? "").trim();
    // Queue the raw fields to replay on reconnect, landing on the entered date
    // (issue #28) — the server re-runs the same normalizeVitalsInput on replay.
    const queueOffline = async () => {
      await enqueue("vitals", date, raw);
      toast("Saved offline — will sync when you reconnect.");
      formRef.current?.reset();
    };

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline();
      return;
    }
    try {
      await addVitals(formData);
    } catch (err) {
      if (shouldQueueOffline(navigator.onLine !== false, err)) {
        await queueOffline();
        return;
      }
      setError("Couldn't save these vitals. Please try again.");
      return;
    }
    toast("Vitals saved");
    formRef.current?.reset();
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="vitals-quick-add"
    >
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log vitals
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Blood pressure, glucose, oxygen, temperature, sleep, HRV, or the
          functional-fitness markers — fill in only what you measured. Shows up
          alongside synced readings.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="v-date">
            Date
          </label>
          <DateField
            id="v-date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="v-systolic">
            Systolic (mmHg)
          </label>
          <input
            id="v-systolic"
            type="number"
            step="1"
            min="0"
            name="systolic"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="v-diastolic">
            Diastolic (mmHg)
          </label>
          <input
            id="v-diastolic"
            type="number"
            step="1"
            min="0"
            name="diastolic"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-glucose">
            Glucose
          </label>
          <div className="flex gap-2">
            <input
              id="v-glucose"
              type="number"
              step="0.1"
              min="0"
              name="glucose"
              className="input"
            />
            <select
              name="glucose_unit"
              aria-label="Glucose unit"
              defaultValue="mg/dL"
              className="input w-auto"
            >
              <option value="mg/dL">mg/dL</option>
              <option value="mmol/L">mmol/L</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="v-spo2">
            Oxygen sat. (%)
          </label>
          <input
            id="v-spo2"
            type="number"
            step="0.1"
            min="0"
            max="100"
            name="spo2"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-temperature">
            Temperature
          </label>
          <div className="flex gap-2">
            <input
              id="v-temperature"
              type="number"
              step="0.1"
              name="temperature"
              className="input"
            />
            <select
              name="temp_unit"
              aria-label="Temperature unit"
              defaultValue="F"
              className="input w-auto"
            >
              <option value="F">°F</option>
              <option value="C">°C</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="v-sleep">
            Sleep (hours)
          </label>
          <input
            id="v-sleep"
            type="number"
            step="0.1"
            min="0"
            max="24"
            name="sleep_hours"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-hrv">
            HRV (ms)
          </label>
          <input
            id="v-hrv"
            type="number"
            step="1"
            min="0"
            name="hrv"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-grip">
            Grip strength (kg)
          </label>
          <input
            id="v-grip"
            type="number"
            step="0.1"
            min="0"
            name="grip_strength"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-chair">
            Chair stands (30s reps)
          </label>
          <input
            id="v-chair"
            type="number"
            step="1"
            min="0"
            name="chair_stand"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="v-balance">
            Single-leg balance (s)
          </label>
          <input
            id="v-balance"
            type="number"
            step="0.1"
            min="0"
            name="balance"
            className="input"
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <SubmitButton pendingLabel="Saving…">Save vitals</SubmitButton>
    </form>
  );
}
