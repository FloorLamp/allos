"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { IconChevronDown } from "@tabler/icons-react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { validateVitalsInput } from "@/lib/vitals-input";
import { validateGrowthInput } from "@/lib/growth-input";
import {
  deepLinkFieldId,
  deepLinkGroup,
  measurementGroupSummary,
  DEFAULT_MEASUREMENT_GROUP,
  MEASUREMENT_GROUPS,
  MEASUREMENT_GROUP_LABEL,
  type MeasurementGroup,
} from "@/lib/measurements-deeplink";
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
// ── The layout is INTRINSIC, never a viewport breakpoint (issue #2014) ───────
// Those three hosts are ~400px (the quick-entry BottomSheet, `sm:max-w-md` less its
// padding), ~912px (the Trends modal, `max-w-5xl`) and a page column. The grid used
// `sm:grid-cols-2 lg:grid-cols-4` — VIEWPORT queries, which read the window and know
// nothing about the box the form is in. At a 1024px window the sheet therefore laid
// four columns into 400px: 91px each, three-line label wraps, inputs at four
// different heights, and `flex` unit rows whose min-content simply painted past the
// panel edge (grid items don't clip). It looked right on a phone and broke as the
// screen got BIGGER, which is why it survived.
//
// `repeat(auto-fit, minmax(10.5rem, 1fr))` asks the CONTAINER instead, so it is
// right in all three hosts and in any host nobody has thought of yet. Two things
// follow from the same reasoning and are part of the same fix:
//   • a unit is not a peer control — it is a suffix INSIDE the field (`bpm`, `%`)
//     or a two-state toggle on the field's trailing edge (°F/°C, mg/dL) — because
//     the `input` + `select` flex row is precisely what overflowed;
//   • a blood pressure is ONE field with two inputs and a slash. Adjacency used to
//     be enforced by array order against a grid that reflows freely, so in a 4-up
//     flow systolic ended row one and diastolic began row two. Temperature and its
//     time are one field for the same reason.
//
// ── Progressive disclosure: three groups, one open ───────────────────────────
// Thirteen always-empty boxes to collect the one or two readings someone actually
// took is what the copy already argues against. Exactly one group is open on mount,
// chosen by where the person came from: the vitals card opens Vitals, Trends → Body
// opens Body, a `?focus=`/`?new=` deep link opens the group holding its field, and
// the quick-log sheet opens whatever this profile last wrote to (seeded to Vitals).
// The field→group table lives in lib/measurements-deeplink.ts beside the deep-link
// table, so the two can never disagree.
//
// COLLAPSED IS HIDDEN, NEVER UNMOUNTED. Three things depend on that and all three
// fail silently under conditional rendering: the form still POSTS every field (a
// value typed and then collapsed still saves, and the Server Action's shape does not
// change at all); a deep link's `querySelector('#…')` in LogMeasurementsPanel still
// resolves; and the offline queue (lib/offline/writes.ts) reads the same field names
// off the same form. A group holding a value also ANNOUNCES it in its header, so a
// value is never invisible behind a chevron.
//
// ── Field membership has exactly two life-stage variants ─────────────────────
// Order is static within a group (a form whose fields move between visits is
// unusable). Body fat and HRV are gated OFF for a growth-tracked profile (the
// existing showBodyFat / showHrv gates, #493); height and head circumference are
// gated ON. Tab order follows visual order because the fields render in that order.
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
  // The minor variant: height (+ head circ) appear and HRV is gated off. Derived
  // server-side from the same lib/growth-metrics gates the Body charts read.
  showGrowth?: boolean;
  showHeadCirc?: boolean;
  // Fired after a successful save so a MOUNTING CONTEXT can react — the quick-entry
  // overlay closes itself, leaving the user where they were.
  onSaved?: () => void;
  // Optional action for a standalone card mount.
  headerSlot?: ReactNode;
  // A metric detail page narrows this shared form to the observation currently
  // being viewed. Omitted on the Body tab and quick-entry overlay, which keep the
  // combined morning-measurements workflow. Single-metric mode has one field and no
  // disclosure at all — there is nothing to progressively reveal.
  metric?: { key: MeasurementEntryMetric; label: string };
  // A surrounding modal already owns the dialog surface and title, so this form
  // drops its standalone card chrome and duplicate heading in that mount.
  presentation?: "card" | "modal";
  // Which group this ENTRY POINT opens (#2014). A deep link still wins over it.
  // Every SERVER-RENDERED mount passes one, so the last-written memory below (a
  // browser-local read) only ever runs in a client-only mount and cannot produce a
  // hydration mismatch.
  defaultGroup?: MeasurementGroup;
  // Scopes that memory to the data subject, so switching profiles doesn't inherit
  // the other one's open group. Omitted where no memory is wanted.
  profileId?: number;
}

// The last-written group, per profile. A device-local UI preference — which
// disclosure opens first — so it belongs in localStorage rather than in a settings
// tier: it holds no reading and no health fact.
function memoryKey(profileId: number | undefined): string | null {
  return profileId == null ? null : `allos:measurements-group:${profileId}`;
}

function rememberedGroup(
  profileId: number | undefined
): MeasurementGroup | null {
  const key = memoryKey(profileId);
  if (!key || typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(key);
    return MEASUREMENT_GROUPS.includes(stored as MeasurementGroup)
      ? (stored as MeasurementGroup)
      : null;
  } catch {
    return null;
  }
}

function rememberGroup(
  profileId: number | undefined,
  group: MeasurementGroup
): void {
  const key = memoryKey(profileId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, group);
  } catch {
    // A blocked or full localStorage costs the memory, never the save.
  }
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
  defaultGroup,
  profileId,
}: MeasurementsQuickAddProps) {
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

  // The open groups, resolved at FIRST RENDER rather than in an effect:
  // LogMeasurementsPanel hands ModalShell an initial-focus node it finds with
  // `querySelector` during the same commit, and a group opened one render later
  // would leave that field display:none at focus time — the deep link would land
  // nowhere, silently, which is exactly the failure mode this disclosure could
  // introduce.
  const [openGroups, setOpenGroups] = useState<MeasurementGroup[]>(() => [
    deepLinkGroup(focusParam, newParam) ??
      defaultGroup ??
      rememberedGroup(profileId) ??
      DEFAULT_MEASUREMENT_GROUP,
  ]);
  // What each group is holding, for its header. Recomputed from the form itself on
  // every input, so a COLLAPSED group still reports what is in it.
  const [summaries, setSummaries] = useState<
    Partial<Record<MeasurementGroup, string>>
  >({});

  useEffect(() => {
    const id = deepLinkFieldId(focusParam, newParam);
    if (!id) return;
    formRef.current?.scrollIntoView({ block: "center" });
    document.getElementById(id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshSummaries() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const read = (name: string): string | null => {
      const v = data.get(name);
      return v == null ? null : String(v);
    };
    const next: Partial<Record<MeasurementGroup, string>> = {};
    for (const group of MEASUREMENT_GROUPS) {
      const text = measurementGroupSummary(group, read);
      if (text) next[group] = text;
    }
    setSummaries(next);
  }

  function toggleGroup(group: MeasurementGroup) {
    setOpenGroups((open) =>
      open.includes(group) ? open.filter((g) => g !== group) : [...open, group]
    );
  }

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
      peakFlow: s("peak_flow"),
      peakFlowTime: s("peak_flow_time"),
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
      vitals.hrv != null ||
      vitals.peakFlow != null;
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

    // Which group this save WENT to, for the no-context mount's memory. The first
    // group holding something wins, so a morning that logs a weight and a blood
    // pressure reopens on the one the person reached for first.
    const written = MEASUREMENT_GROUPS.find((group) =>
      measurementGroupSummary(group, (name) => {
        const v = formData.get(name);
        return v == null ? null : String(v);
      })
    );
    // Spelled ONCE and called from BOTH save outcomes (#2068). The memory is about
    // which group the person reached for, not about which transport carried it: a
    // reading queued offline is a reading they logged, and the next sheet must open
    // where they left off whether or not the network was up. It was on the online
    // branch alone, so a day of offline entries silently taught the form nothing.
    // A REFUSED save records nothing — an inline validation error and the
    // growth-only offline case never reach here.
    const rememberWritten = (): void => {
      if (written) rememberGroup(profileId, written);
    };

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
      rememberWritten();
      toast("Saved offline — will sync when you reconnect.");
      formRef.current?.reset();
      tempUnitDetection.reset();
      refreshSummaries();
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
    rememberWritten();
    toast(metric ? `${metric.label} saved` : "Measurements saved");
    formRef.current?.reset();
    tempUnitDetection.reset();
    refreshSummaries();
    onSaved?.();
  }

  // ── The fields, authored once and GROUPED below ─────────────────────────────
  // A label names the measure, the field carries its unit, and the group heading
  // carries the domain — so no label appends a second parenthetical to a title that
  // already has one ("BLOOD PRESSURE (SYSTOLIC) (MMHG)", uppercased by `.label`).
  const field = {
    weight: (
      <Field
        key="weight"
        label={BODY_METRIC_META.weight.title}
        htmlFor="m-weight"
      >
        <UnitSuffix suffix={weightUnit}>
          <input
            id="m-weight"
            type="number"
            step="0.1"
            min="0"
            name="weight"
            className="input pr-12"
          />
        </UnitSuffix>
      </Field>
    ),
    bodyFat: (
      <Field
        key="body-fat"
        label={BODY_METRIC_META["body-fat"].title}
        htmlFor="m-body-fat"
      >
        <UnitSuffix suffix={BODY_METRIC_META["body-fat"].unit}>
          <input
            id="m-body-fat"
            type="number"
            step="0.1"
            min="0"
            max="100"
            name="body_fat_pct"
            className="input pr-9"
          />
        </UnitSuffix>
      </Field>
    ),
    height: (
      <Field
        key="height"
        label={BODY_METRIC_META.height.title}
        htmlFor="m-height"
      >
        <UnitToggle
          name="height_unit"
          label={`${BODY_METRIC_META.height.title} unit`}
          options={["cm", "in"]}
        >
          <input
            id="m-height"
            type="number"
            step="0.1"
            min="0"
            name="height"
            className="input pr-16"
          />
        </UnitToggle>
      </Field>
    ),
    headCirc: (
      <Field
        key="head-circ"
        label={BODY_METRIC_META["head-circ"].title}
        htmlFor="m-head-circ"
      >
        <UnitToggle
          name="head_circ_unit"
          label={`${BODY_METRIC_META["head-circ"].title} unit`}
          options={["cm", "in"]}
        >
          <input
            id="m-head-circ"
            type="number"
            step="0.1"
            min="0"
            name="head_circ"
            className="input pr-16"
          />
        </UnitToggle>
      </Field>
    ),
    // A blood pressure is ONE reading typed as two numbers — one field, two inputs
    // and a slash. Adjacency used to be an ordering convention against a grid that
    // reflows freely; here it is structural.
    bloodPressure: (
      <Field key="blood-pressure" label="Blood Pressure" htmlFor="m-systolic">
        <div className="flex items-center gap-1.5">
          <input
            id="m-systolic"
            type="number"
            step="1"
            min="0"
            name="systolic"
            aria-label="Systolic"
            placeholder="Sys"
            className="input min-w-0 flex-1"
          />
          <span aria-hidden className="text-slate-400">
            /
          </span>
          <input
            id="m-diastolic"
            type="number"
            step="1"
            min="0"
            name="diastolic"
            aria-label="Diastolic"
            placeholder="Dia"
            className="input min-w-0 flex-1"
          />
          <span className="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
            {BODY_METRIC_META.systolic.unit.trim()}
          </span>
        </div>
      </Field>
    ),
    glucose: (
      <Field key="glucose" label="Glucose" htmlFor="m-glucose">
        <UnitToggle
          name="glucose_unit"
          label="Glucose unit"
          options={["mg/dL", "mmol/L"]}
        >
          <input
            id="m-glucose"
            type="number"
            step="0.1"
            min="0"
            name="glucose"
            className="input pr-24"
          />
        </UnitToggle>
      </Field>
    ),
    spo2: (
      <Field key="spo2" label={BODY_METRIC_META.spo2.title} htmlFor="m-spo2">
        <UnitSuffix suffix={BODY_METRIC_META.spo2.unit}>
          <input
            id="m-spo2"
            type="number"
            step="0.1"
            min="0"
            max="100"
            name="spo2"
            className="input pr-9"
          />
        </UnitSuffix>
      </Field>
    ),
    // The #800/#843 fever-curve time field rides WITH temperature — inside the same
    // field, so no reflow can separate a temperature from when it was taken.
    temperature: (
      <Field
        key="temperature"
        label={BODY_METRIC_META.temperature.title}
        htmlFor="m-temperature"
      >
        <UnitToggle
          name="temp_unit"
          label={`${BODY_METRIC_META.temperature.title} unit`}
          options={["F", "C"]}
          optionLabels={{ F: "°F", C: "°C" }}
          value={tempUnitDetection.unit}
          onChange={(v) => tempUnitDetection.chooseUnit(v === "C" ? "C" : "F")}
        >
          <input
            id="m-temperature"
            type="number"
            step="0.1"
            name="temperature"
            onChange={(event) =>
              tempUnitDetection.readValue(event.target.value)
            }
            className="input pr-16"
          />
        </UnitToggle>
        {tempUnitDetection.detectedUnit && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Detected °{tempUnitDetection.detectedUnit} from the reading.
          </p>
        )}
        <label
          className="mt-1.5 block text-xs text-slate-500 dark:text-slate-400"
          htmlFor="m-temp-time"
        >
          Time taken (optional)
        </label>
        <input
          id="m-temp-time"
          data-testid="measurements-temp-time"
          type="time"
          name="temp_time"
          className="input mt-1"
        />
      </Field>
    ),
    sleep: (
      <Field key="sleep" label="Sleep" htmlFor="m-sleep">
        <UnitSuffix suffix="hrs">
          <input
            id="m-sleep"
            type="number"
            step="0.1"
            min="0"
            max="24"
            name="sleep_hours"
            className="input pr-12"
          />
        </UnitSuffix>
      </Field>
    ),
    hrv: (
      <Field key="hrv" label={BODY_METRIC_META.hrv.title} htmlFor="m-hrv">
        <UnitSuffix suffix={BODY_METRIC_META.hrv.unit.trim()}>
          <input
            id="m-hrv"
            type="number"
            step="1"
            min="0"
            name="hrv"
            className="input pr-10"
          />
        </UnitSuffix>
      </Field>
    ),
    peakFlow: (
      <Field
        key="peak-flow"
        label={BODY_METRIC_META["peak-flow"].title}
        htmlFor="m-peak-flow"
      >
        <UnitSuffix suffix={BODY_METRIC_META["peak-flow"].unit.trim()}>
          <input
            id="m-peak-flow"
            data-testid="measurements-peak-flow"
            type="number"
            step="1"
            min="0"
            name="peak_flow"
            className="input pr-14"
          />
        </UnitSuffix>
        {/* Peak flow is monitored once or twice a day during a flare (#1850), so the
            blow carries the clock time it was taken at — without it the evening
            reading would correct the morning's instead of joining it. */}
        <label
          className="mt-1.5 block text-xs text-slate-500 dark:text-slate-400"
          htmlFor="m-peak-flow-time"
        >
          Time taken (optional)
        </label>
        <input
          id="m-peak-flow-time"
          data-testid="measurements-peak-flow-time"
          type="time"
          name="peak_flow_time"
          className="input mt-1"
        />
      </Field>
    ),
    restingHr: (
      <Field
        key="resting-hr"
        label={BODY_METRIC_META["resting-hr"].title}
        htmlFor="m-resting-hr"
      >
        <UnitSuffix suffix={BODY_METRIC_META["resting-hr"].unit.trim()}>
          <input
            id="m-resting-hr"
            type="number"
            min="0"
            name="resting_hr"
            className="input pr-12"
          />
        </UnitSuffix>
      </Field>
    ),
  };

  // Notes is the ONE full-width field: a narrow cell with three columns of dead
  // space beside it, holding free text in an `<input>`, was the grid winning an
  // argument it should not have been in.
  const notesField = (
    <div>
      <label className="label" htmlFor="m-notes">
        Notes
      </label>
      <textarea id="m-notes" name="notes" rows={2} className="input" />
    </div>
  );

  const scopedFields: Record<MeasurementEntryMetric, ReactNode[]> = {
    weight: [field.weight],
    "body-fat": [field.bodyFat],
    "resting-hr": [field.restingHr],
    "blood-pressure": [field.bloodPressure],
    spo2: [field.spo2],
    temperature: [field.temperature],
    hrv: [field.hrv],
    height: [field.height],
    "head-circ": [field.headCirc],
    "peak-flow": [field.peakFlow],
  };

  const groupFields: Record<MeasurementGroup, ReactNode[]> = {
    vitals: [
      field.bloodPressure,
      field.restingHr,
      field.spo2,
      field.temperature,
      field.glucose,
      field.peakFlow,
    ],
    body: [
      field.weight,
      ...(showBodyFat ? [field.bodyFat] : []),
      ...(showGrowth ? [field.height] : []),
      ...(showGrowth && showHeadCirc ? [field.headCirc] : []),
    ],
    sleep: [field.sleep, ...(showHrv ? [field.hrv] : [])],
  };

  return (
    <form
      id="measurements-quick-add"
      ref={formRef}
      action={handle}
      onInput={refreshSummaries}
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

      <div className={GRID_CLASS}>
        <Field label="Date" htmlFor="m-date">
          <DateField
            id="m-date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </Field>
        {metric ? scopedFields[metric.key] : null}
      </div>

      {!metric && (
        <div className="space-y-2">
          {MEASUREMENT_GROUPS.filter(
            (group) => groupFields[group].length > 0
          ).map((group) => {
            const open = openGroups.includes(group);
            const summary = summaries[group];
            return (
              <section
                key={group}
                data-testid={`measurements-group-${group}`}
                className="rounded-lg border border-black/5 dark:border-white/10"
              >
                <h3>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group)}
                    aria-expanded={open}
                    aria-controls={`measurements-group-${group}-fields`}
                    data-testid={`measurements-group-${group}-toggle`}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-800 hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-100 dark:hover:bg-white/[0.04]"
                  >
                    <span className="shrink-0">
                      {MEASUREMENT_GROUP_LABEL[group]}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      {summary && (
                        <span
                          data-testid={`measurements-group-${group}-summary`}
                          className="truncate text-xs font-normal tabular-nums text-slate-500 dark:text-slate-400"
                        >
                          {summary}
                        </span>
                      )}
                      <IconChevronDown
                        className={`h-4 w-4 shrink-0 text-slate-400 transition ${
                          open ? "rotate-180" : ""
                        }`}
                        stroke={1.75}
                        aria-hidden
                      />
                    </span>
                  </button>
                </h3>
                {/* HIDDEN, not unmounted: a collapsed value still posts, a deep
                    link still resolves, and the offline queue still finds it. */}
                <div
                  id={`measurements-group-${group}-fields`}
                  // `hidden` REPLACES the grid class rather than joining it: two
                  // display utilities on one element are resolved by Tailwind's
                  // output order, not by the order they are written here.
                  className={open ? `${GRID_CLASS} px-3 pb-3` : "hidden"}
                >
                  {groupFields[group]}
                </div>
              </section>
            );
          })}
          {notesField}
        </div>
      )}

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

// INTRINSIC columns (#2014): sized by the CONTAINER, not by the window, because
// this one form is mounted in hosts ~400px, ~912px and a page column wide. Picking
// a better breakpoint value only moves which host is wrong.
const GRID_CLASS =
  "grid gap-3 grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))]";

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
    <div className="min-w-0">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

// A unit the user does NOT choose, printed inside the field's trailing edge. The
// input carries matching right padding, so a value can never run under it.
function UnitSuffix({
  suffix,
  children,
}: {
  suffix: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-slate-500 dark:text-slate-400">
        {suffix}
      </span>
    </div>
  );
}

// A unit the user DOES choose: a two-state control on the field's trailing edge
// instead of a peer `select` in a flex row (which is what overflowed a 91px cell).
// Still a real `<select>` under the same `name`, so the posted FormData — and the
// offline queue reading the same names off the same form — are unchanged.
function UnitToggle({
  name,
  label,
  options,
  optionLabels,
  value,
  onChange,
  children,
}: {
  name: string;
  label: string;
  options: string[];
  optionLabels?: Record<string, string>;
  value?: string;
  onChange?: (value: string) => void;
  children: ReactNode;
}) {
  const controlled = value !== undefined && onChange !== undefined;
  return (
    <div className="relative">
      {children}
      <select
        name={name}
        aria-label={label}
        {...(controlled
          ? { value, onChange: (e) => onChange(e.target.value) }
          : { defaultValue: options[0] })}
        // The existing borderless in-field select primitive — it already pins the
        // OPEN option list's colors in dark mode, which a hand-rolled transparent
        // select gets wrong (light text on a white popup).
        className="select-bare absolute inset-y-1 right-1 py-0 pl-1.5 text-xs"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </option>
        ))}
      </select>
    </div>
  );
}
