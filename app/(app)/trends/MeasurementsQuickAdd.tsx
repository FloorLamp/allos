"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { validateVitalsInput } from "@/lib/vitals-input";
import { validateGrowthInput } from "@/lib/growth-input";
import { deepLinkFieldId } from "@/lib/measurements-deeplink";
import {
  isMeasurementEntryAllowed,
  type MeasurementEntryMetric,
} from "@/lib/measurement-entry";
import { shouldQueueOffline } from "@/lib/offline/queue";
import type { TemperatureUnit, WeightUnit } from "@/lib/settings";
import { BODY_METRIC_META } from "@/lib/trends-body-metrics";
import { addMeasurements } from "./measurement-actions";

export type { MeasurementEntryMetric } from "@/lib/measurement-entry";

// The combined "Log measurements" form (issue #1486).
//
// Trends carried THREE daily-log forms — body (weight / body fat / resting HR),
// vitals (BP / glucose / SpO2 / temperature / sleep / HRV) and, for a minor, growth
// (height / head circ) — split across two tabs. A morning's readings are one act, so
// they are now one form.
//
// ── ONE component, three mounting contexts ───────────────────────────────────
// This is the whole form, authored once (the responsive shared-content rule). It is
// mounted by:
//   • the Body tab's desktop "+ Log" modal (BodySection → LogMeasurementsPanel),
//   • the #1467/#1468 quick-entry overlay (the phone's ONLY on-page logging path),
//   • the per-metric detail pages (/trends/metric/<slug>).
// `onSaved` is the only behavioural difference between them — the overlay closes
// itself after a save; the page mounts simply reset and stay put.
//
// ── Field order is STATIC, with exactly two life-stage variants ──────────────
// Never live-ranked (a form whose fields move between visits is unusable):
//   Adult: weight → body fat → BP (sys/dia adjacent) → glucose → SpO2 →
//          temperature → sleep → HRV → resting HR → notes.
//   Minor: weight → height → head circ (age-gated) → temperature → SpO2 → BP →
//          glucose → sleep → resting HR → notes; body fat + HRV gated OFF (the
//          existing showBodyFat / growth gates, #493).
// Tab order follows visual order because the fields are rendered in that order.
//
// ── What is NOT here ─────────────────────────────────────────────────────────
// The three #158 functional-fitness markers (grip strength, 30-second chair stand,
// single-leg balance) used to sit in the vitals form. They are ASSESSMENT-cadence
// measures — you do them on a schedule, alongside VO2 and a sit-and-reach, not on
// the morning you weigh yourself — so they live with the guided Fitness check on
// /training (#1275). Their canonical storage is untouched (the same medical_records
// vitals rows, scored by the same lib/fitness-norms engine); only the entry surface
// moved.
//
// Resting HR and Notes are retained from the body quick-add: both are daily-cadence
// and both are reachable by an existing deep link (`?new=vitals` focuses resting
// HR), so dropping them would be a silent regression rather than a simplification.

export interface MeasurementsQuickAddProps {
  defaultDate: string;
  weightUnit: WeightUnit;
  // The viewer's login temperature-unit preference (#857) — seeds the temp entry
  // unit. Storage stays canonical °F.
  temperatureUnit?: TemperatureUnit;
  // #493: body fat isn't tracked for a growth-tracked profile — the ONE showBodyFat
  // predicate, applied here exactly as it is to the charts and the history column.
  showBodyFat?: boolean;
  // The minor variant: height (+ head circ) appear, HRV is gated off, and the field
  // order switches. Derived server-side from the same lib/growth-metrics gates the
  // Body charts read.
  showGrowth?: boolean;
  showHeadCirc?: boolean;
  // Fired after a successful save so a MOUNTING CONTEXT can react — the quick-entry
  // overlay closes itself, leaving the user where they were.
  onSaved?: () => void;
  // Optional action for a standalone card mount.
  headerSlot?: ReactNode;
  // A metric detail page narrows this shared form to the observation currently
  // being viewed. Omitted on the Body tab and quick-entry overlay, which keep the
  // combined morning-measurements workflow.
  metric?: { key: MeasurementEntryMetric; label: string };
  // A surrounding modal already owns the dialog surface and title, so this form
  // drops its standalone card chrome and duplicate heading in that mount.
  presentation?: "card" | "modal";
}

export default function MeasurementsQuickAdd({
  defaultDate,
  weightUnit,
  temperatureUnit = "F",
  showBodyFat = true,
  showGrowth = false,
  showHeadCirc = false,
  onSaved,
  headerSlot,
  metric,
  presentation = "card",
}: MeasurementsQuickAddProps) {
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const tempUnitDetection = useTemperatureUnitDetection(temperatureUnit);
  // HRV is an adult measure here for the same reason body fat is (#493): a
  // growth-tracked profile's Body surfaces don't carry it, so the field doesn't
  // either — "not tracked" stays consistent instead of hidden-yet-enterable.
  const showHrv = !showGrowth;

  // Deep links (#1083 / #1146 / #29). `focus=` is the care-surface convention
  // (blood-pressure, sleep, height) and `new=` is the command palette's
  // (weight, vitals). BOTH resolve to a field in THIS one form now — the merge is
  // what makes that possible — so every historical deep link keeps working.
  const params = useSearchParams();
  const focusParam = params.get("focus");
  const newParam = params.get("new");
  useEffect(() => {
    const id = deepLinkFieldId(focusParam, newParam);
    if (!id) return;
    formRef.current?.scrollIntoView({ block: "center" });
    document.getElementById(id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The detail page applies this before rendering its Log Manually trigger. Keep
  // the form guarded too so a future mounting context cannot bypass the gates.
  if (
    metric &&
    !isMeasurementEntryAllowed(metric.key, {
      showBodyFat,
      showGrowth,
      showHeadCirc,
    })
  ) {
    return null;
  }

  async function handle(formData: FormData) {
    setError(null);
    const s = (k: string): string | null => {
      const v = formData.get(k);
      return v === null || String(v).trim() === "" ? null : String(v);
    };
    const date = String(formData.get("date") ?? "").trim();

    const body = {
      weight: s("weight"),
      bodyFatPct: s("body_fat_pct"),
      restingHr: s("resting_hr"),
      notes: s("notes"),
    };
    const vitals = {
      systolic: s("systolic"),
      diastolic: s("diastolic"),
      glucose: s("glucose"),
      glucoseUnit: s("glucose_unit"),
      spo2: s("spo2"),
      temperature: s("temperature"),
      tempUnit: s("temp_unit"),
      temperatureTime: s("temp_time"),
      sleepHours: s("sleep_hours"),
      hrv: s("hrv"),
    };
    const growth = {
      height: s("height"),
      heightUnit: s("height_unit"),
      headCirc: s("head_circ"),
      headCircUnit: s("head_circ_unit"),
    };

    const hasBody =
      body.weight != null || body.bodyFatPct != null || body.restingHr != null;
    const hasVitals =
      vitals.systolic != null ||
      vitals.diastolic != null ||
      vitals.glucose != null ||
      vitals.spo2 != null ||
      vitals.temperature != null ||
      vitals.sleepHours != null ||
      vitals.hrv != null;
    const hasGrowth = growth.height != null || growth.headCirc != null;

    if (!hasBody && !hasVitals && !hasGrowth) {
      setError("Enter at least one measurement.");
      return;
    }
    // The combined form retains its historical body-composition contract: a note
    // belongs to a weigh-in. Metric-scoped body-fat/resting-HR forms deliberately
    // have no weight field; those nullable observations persist independently.
    if (!hasBody && body.notes != null && body.notes.trim() !== "") {
      setError("Enter a weight to save a note.");
      return;
    }

    // The same pure guards the server cores run, so an out-of-range value surfaces
    // inline instead of as a false "saved".
    const firstError =
      (hasBody
        ? validateBodyMetricInput(
            {
              weight: body.weight,
              bodyFatPct: body.bodyFatPct,
              restingHr: body.restingHr,
            },
            {
              requireWeight:
                metric?.key !== "body-fat" && metric?.key !== "resting-hr",
            }
          )
        : null) ??
      (hasVitals ? validateVitalsInput(vitals) : null) ??
      (hasGrowth ? validateGrowthInput(growth) : null);
    if (firstError) {
      setError(firstError);
      return;
    }

    // Offline: replay each half through its OWN queued intent — the queue's flow
    // kinds are the write cores, and this form is a composition of them, not a new
    // kind. (Growth has no queue flow; a growth-only entry offline is reported as a
    // failure rather than silently dropped.)
    const queueOffline = async (): Promise<boolean> => {
      if (hasGrowth) return false;
      if (hasBody) {
        await enqueue("body-metric", date, {
          weight: String(body.weight ?? ""),
          weightUnit,
          bodyFatPct: body.bodyFatPct,
          restingHr: body.restingHr,
          notes: body.notes,
        });
      }
      if (hasVitals) await enqueue("vitals", date, vitals);
      toast("Saved offline — will sync when you reconnect.");
      formRef.current?.reset();
      tempUnitDetection.reset();
      return true;
    };

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (await queueOffline()) return;
      setError("You're offline — reconnect to save these measurements.");
      return;
    }
    try {
      await addMeasurements(formData);
    } catch (err) {
      if (shouldQueueOffline(navigator.onLine !== false, err)) {
        if (await queueOffline()) return;
      }
      setError("Couldn't save these measurements. Try again.");
      return;
    }
    toast(metric ? `${metric.label} saved` : "Measurements saved");
    formRef.current?.reset();
    tempUnitDetection.reset();
    router.refresh();
    onSaved?.();
  }

  // ── The fields, authored once and ORDERED by life stage below ───────────────
  const field = {
    weight: (
      <Field
        key="weight"
        label={`${BODY_METRIC_META.weight.title} (${weightUnit})`}
        htmlFor="m-weight"
      >
        <input
          id="m-weight"
          type="number"
          step="0.1"
          min="0"
          name="weight"
          className="input"
        />
      </Field>
    ),
    bodyFat: (
      <Field
        key="body-fat"
        label={`${BODY_METRIC_META["body-fat"].title} (${BODY_METRIC_META["body-fat"].unit})`}
        htmlFor="m-body-fat"
      >
        <input
          id="m-body-fat"
          type="number"
          step="0.1"
          min="0"
          max="100"
          name="body_fat_pct"
          className="input"
        />
      </Field>
    ),
    height: (
      <Field
        key="height"
        label={BODY_METRIC_META.height.title}
        htmlFor="m-height"
      >
        <div className="flex gap-2">
          <input
            id="m-height"
            type="number"
            step="0.1"
            min="0"
            name="height"
            className="input"
          />
          <select
            name="height_unit"
            aria-label={`${BODY_METRIC_META.height.title} unit`}
            defaultValue="cm"
            className="input w-auto"
          >
            <option value="cm">cm</option>
            <option value="in">in</option>
          </select>
        </div>
      </Field>
    ),
    headCirc: (
      <Field
        key="head-circ"
        label={BODY_METRIC_META["head-circ"].title}
        htmlFor="m-head-circ"
      >
        <div className="flex gap-2">
          <input
            id="m-head-circ"
            type="number"
            step="0.1"
            min="0"
            name="head_circ"
            className="input"
          />
          <select
            name="head_circ_unit"
            aria-label={`${BODY_METRIC_META["head-circ"].title} unit`}
            defaultValue="cm"
            className="input w-auto"
          >
            <option value="cm">cm</option>
            <option value="in">in</option>
          </select>
        </div>
      </Field>
    ),
    // Systolic + diastolic are ADJACENT in both variants — a blood pressure is one
    // reading typed as two numbers, never separated by another measure.
    systolic: (
      <Field
        key="systolic"
        label={`${BODY_METRIC_META.systolic.title} (${BODY_METRIC_META.systolic.unit.trim()})`}
        htmlFor="m-systolic"
      >
        <input
          id="m-systolic"
          type="number"
          step="1"
          min="0"
          name="systolic"
          className="input"
        />
      </Field>
    ),
    diastolic: (
      <Field
        key="diastolic"
        label={`${BODY_METRIC_META.diastolic.title} (${BODY_METRIC_META.diastolic.unit.trim()})`}
        htmlFor="m-diastolic"
      >
        <input
          id="m-diastolic"
          type="number"
          step="1"
          min="0"
          name="diastolic"
          className="input"
        />
      </Field>
    ),
    glucose: (
      <Field key="glucose" label="Glucose" htmlFor="m-glucose">
        <div className="flex gap-2">
          <input
            id="m-glucose"
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
      </Field>
    ),
    spo2: (
      <Field
        key="spo2"
        label={`${BODY_METRIC_META.spo2.title} (${BODY_METRIC_META.spo2.unit})`}
        htmlFor="m-spo2"
      >
        <input
          id="m-spo2"
          type="number"
          step="0.1"
          min="0"
          max="100"
          name="spo2"
          className="input"
        />
      </Field>
    ),
    temperature: (
      <Field
        key="temperature"
        label={BODY_METRIC_META.temperature.title}
        htmlFor="m-temperature"
      >
        <div className="flex gap-2">
          <input
            id="m-temperature"
            type="number"
            step="0.1"
            name="temperature"
            onChange={(event) =>
              tempUnitDetection.readValue(event.target.value)
            }
            className="input"
          />
          <select
            name="temp_unit"
            aria-label={`${BODY_METRIC_META.temperature.title} unit`}
            value={tempUnitDetection.unit}
            onChange={(event) =>
              tempUnitDetection.chooseUnit(
                event.target.value === "C" ? "C" : "F"
              )
            }
            className="input w-auto"
          >
            <option value="F">°F</option>
            <option value="C">°C</option>
          </select>
        </div>
        {tempUnitDetection.detectedUnit && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Detected °{tempUnitDetection.detectedUnit} from the reading.
          </p>
        )}
      </Field>
    ),
    // The #800/#843 fever-curve time field rides WITH temperature in both variants.
    tempTime: (
      <Field
        key="temp-time"
        label="Temp. time (optional)"
        htmlFor="m-temp-time"
      >
        <input
          id="m-temp-time"
          data-testid="measurements-temp-time"
          type="time"
          name="temp_time"
          className="input"
        />
      </Field>
    ),
    sleep: (
      <Field key="sleep" label="Sleep (hours)" htmlFor="m-sleep">
        <input
          id="m-sleep"
          type="number"
          step="0.1"
          min="0"
          max="24"
          name="sleep_hours"
          className="input"
        />
      </Field>
    ),
    hrv: (
      <Field
        key="hrv"
        label={`${BODY_METRIC_META.hrv.title} (${BODY_METRIC_META.hrv.unit.trim()})`}
        htmlFor="m-hrv"
      >
        <input
          id="m-hrv"
          type="number"
          step="1"
          min="0"
          name="hrv"
          className="input"
        />
      </Field>
    ),
    restingHr: (
      <Field
        key="resting-hr"
        label={`${BODY_METRIC_META["resting-hr"].title} (${BODY_METRIC_META["resting-hr"].unit.trim()})`}
        htmlFor="m-resting-hr"
      >
        <input
          id="m-resting-hr"
          type="number"
          min="0"
          name="resting_hr"
          className="input"
        />
      </Field>
    ),
    notes: (
      <Field key="notes" label="Notes" htmlFor="m-notes">
        <input id="m-notes" name="notes" className="input" />
      </Field>
    ),
  };

  const scopedFields: Record<MeasurementEntryMetric, ReactNode[]> = {
    weight: [field.weight],
    "body-fat": [field.bodyFat],
    "resting-hr": [field.restingHr],
    "blood-pressure": [field.systolic, field.diastolic],
    spo2: [field.spo2],
    temperature: [field.temperature, field.tempTime],
    hrv: [field.hrv],
    height: [field.height],
    "head-circ": [field.headCirc],
  };
  const ordered: ReactNode[] = metric
    ? scopedFields[metric.key]
    : showGrowth
      ? [
          field.weight,
          field.height,
          ...(showHeadCirc ? [field.headCirc] : []),
          field.temperature,
          field.tempTime,
          field.spo2,
          field.systolic,
          field.diastolic,
          field.glucose,
          field.sleep,
          field.restingHr,
          field.notes,
        ]
      : [
          field.weight,
          ...(showBodyFat ? [field.bodyFat] : []),
          field.systolic,
          field.diastolic,
          field.glucose,
          field.spo2,
          field.temperature,
          field.tempTime,
          field.sleep,
          ...(showHrv ? [field.hrv] : []),
          field.restingHr,
          field.notes,
        ];

  return (
    <form
      id="measurements-quick-add"
      ref={formRef}
      action={handle}
      className={`${presentation === "card" ? "card" : ""} space-y-3 ${
        metric ? "max-w-2xl" : ""
      }`}
      data-testid="measurements-quick-add"
      data-life-stage={showGrowth ? "minor" : "adult"}
    >
      <input type="hidden" name="weight_unit" value={weightUnit} />
      {presentation === "card" ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              {metric ? `Log ${metric.label}` : "Log measurements"}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {metric
                ? `Add one manual ${metric.label.toLowerCase()} reading. It will appear alongside synced readings.`
                : "Today’s body and vitals readings — fill in only what you measured. Shows up alongside synced readings."}
            </p>
          </div>
          {headerSlot}
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {metric
            ? `Add one manual ${metric.label.toLowerCase()} reading. It will appear alongside synced readings.`
            : "Today’s body and vitals readings — fill in only what you measured. Shows up alongside synced readings."}
        </p>
      )}

      <div
        className={`grid gap-3 sm:grid-cols-2 ${
          metric ? "" : "lg:grid-cols-4"
        }`}
      >
        <Field label="Date" htmlFor="m-date">
          <DateField
            id="m-date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </Field>
        {ordered}
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <SubmitButton pendingLabel="Saving…">
        {metric ? `Save ${metric.label.toLowerCase()}` : "Save measurements"}
      </SubmitButton>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
