"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { IconChevronDown } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";
import TemperatureField from "@/components/vitals/TemperatureField";
import WeightField from "@/components/vitals/WeightField";
import TimeRangeFields from "@/components/TimeRangeFields";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  measurementsSavedText,
  validateBodyMetricInput,
} from "@/lib/body-metric-input";
import { validateVitalsInput } from "@/lib/vitals-input";
import { validateGrowthInput } from "@/lib/growth-input";
import { validateWaistInput } from "@/lib/waist-input";
import { validateCompositionInput } from "@/lib/composition-input";
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
import {
  MEASUREMENTS_PARTIAL_REFUSED_MESSAGE,
  MEASUREMENTS_WAIST_REFUSED_MESSAGE,
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import type { TemperatureUnit, WeightUnit } from "@/lib/settings";
import { TREND_METRIC_META } from "@/lib/trend-metrics";
import InlineError from "@/components/InlineError";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import {
  addMeasurements,
  type MeasurementsSaveResult,
} from "./measurement-actions";

export type { MeasurementEntryMetric } from "@/lib/measurement-entry";

// Which refusal sentence a queued capture gets. The shared one when the device kept
// NOTHING; the partial one when the body half is already in the queue and only the
// vitals were refused (#3118) — the badge would otherwise say "1 queued offline"
// under a sentence saying nothing was saved.
function refusedMessage(
  captured: "refused" | "partial" | "partial-waist"
): string {
  if (captured === "partial") return MEASUREMENTS_PARTIAL_REFUSED_MESSAGE;
  return captured === "partial-waist"
    ? MEASUREMENTS_WAIST_REFUSED_MESSAGE
    : OFFLINE_CAPTURE_REFUSED_MESSAGE;
}

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
//   • the body census desktop "+ Log" modal (BodySection → LogMeasurementsPanel),
//   • the #1467/#1468 quick-entry overlay (the phone's ONLY on-page logging path),
//   • the per-metric detail pages (/trends/metric/<slug>).
// `onSaved` is the only behavioural difference between them — the overlay closes
// itself after a save; the page mounts simply reset and stay put.
//
// ── The layout is INTRINSIC, never a viewport breakpoint (issue #2014) ───────
// Those three hosts are the quick-entry BottomSheet, the Trends modal and a page
// column — and the first two are the SAME declared bucket since #4977, which is a
// fact about the hosts and not about this file. The grid used
// `sm:grid-cols-2 lg:grid-cols-4` — VIEWPORT queries, which read the window and know
// nothing about the box the form is in. At a 1024px window the sheet therefore laid
// four columns into 400px: 91px each, three-line label wraps, inputs at four
// different heights, and `flex` unit rows whose min-content simply painted past the
// panel edge (grid items don't clip). It looked right on a phone and broke as the
// screen got BIGGER, which is why it survived.
//
// `repeat(auto-fit, minmax(10.5rem, 1fr))` asks the CONTAINER instead, so it is
// right in all three hosts and in any host nobody has thought of yet. THAT IS ALSO
// WHY #4977 IS A ONE-LINE CHANGE SOMEWHERE ELSE: the quick-entry sheet was narrow
// because its host declared no size and took the default bucket, and declaring `lg`
// there (components/QuickEntryProvider.tsx's `SHEET`) flows this grid to four
// fields a row with nothing in this file touched. A breakpoint added here would be
// the defect above coming back — if a fix for a HOST's width wants a `md:` or `lg:`
// on the grid below, the host is the thing to fix.
//
// Two things follow from the same reasoning and are part of the same fix:
//   • a unit is not a peer control — it is a suffix INSIDE the field (`bpm`, `%`)
//     or a two-state toggle on the field's trailing edge (°F/°C, mg/dL) — because
//     the `input` + `select` flex row is precisely what overflowed;
//   • a blood pressure is ONE field with two inputs and a slash. Adjacency used to
//     be enforced by array order against a grid that reflows freely, so in a 4-up
//     flow systolic ended row one and diastolic began row two. Temperature and its
//     time are one field for the same reason.
//
// ── Progressive disclosure: three groups, one open ───────────────────────────
// EIGHTEEN always-empty boxes to collect the one or two readings someone actually
// took is what the copy already argues against. (This comment said THIRTEEN, which was
// the count before #1850, #1851 and #2322 added peak flow, the bed/wake pair,
// respiratory rate, lean and bone mass, hydration and the waist tape, then SEVENTEEN
// once those landed. `LOG_MANIFEST` inherited each stale figure and #4424's body leg
// corrected it in its turn. The form DEFINES nineteen fields — the eighteen in `field`
// below plus Notes — and renders eighteen labeled boxes at the adult life stage (#4976:
// the bed/wake pair draws its own two labels, "Bed time" / "Wake time", rather than
// one shared "Bed & wake" — one field, two boxes, so the rendered count is no longer
// the field count) and sixteen at the minor's, since the growth pair swaps in exactly
// as body fat and HRV swap out; `components/__tests__/body-two-pieces.test.tsx` asserts
// the pair.) Exactly one group is open on mount,
// chosen by where the person came from: the vitals card opens Vitals, Trends → Overview → body census
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
// unusable). HRV and the whole body-composition class — body fat %, lean mass, bone
// mass — are gated OFF for a growth-tracked profile (showHrv, #493; and
// showCompositionEntry, #4147, which gates the three together because they come off
// one DEXA report); height and head circumference are gated ON. Tab order follows
// visual order because the fields render in that order.
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
  // The stated instant already on `defaultDate`'s manual body-metrics row, or null
  // (#2235 decision 5): editing an existing day seeds the Time from the row's own
  // `occurred_at` — the only thing there is to seed, since body_metrics has no
  // record stamp to launder from — so a resubmission preserves a stated time
  // unless the user clears the field. Never a default-to-now: an unseeded form
  // renders the Time EMPTY even when the date is today (#2053), with the
  // control's one-tap "Now" beside it.
  defaultStatedAt?: string | null;
  /**
   * The latest day this form may write, which is the day the write cores already
   * bound it to (`isPastWriteAccepted`). Optional only because a mount that omits it
   * still cannot write the future — `addMeasurements` answers `dateRefused` and the
   * inline refusal below says so — but a bound the control ENFORCES beats one the
   * submission discovers.
   */
  maxDate?: string;
  weightUnit: WeightUnit;
  // The viewer's login temperature-unit preference (#857) — seeds the temp entry
  // unit. Storage stays canonical °F.
  temperatureUnit?: TemperatureUnit;
  // #493/#4147: manual body-composition entry — body fat %, lean mass, bone mass — is
  // closed for a growth-tracked profile, as one class. The ONE showCompositionEntry
  // predicate, applied here exactly as it is on the metric detail routes.
  showCompositionEntry?: boolean;
  // The minor variant: height (+ head circ) appear and HRV is gated off. Derived
  // server-side from the same lib/growth-metrics gates the Body charts read.
  showGrowth?: boolean;
  showHeadCirc?: boolean;
  // Fired after a successful save so a MOUNTING CONTEXT can react — the quick-entry
  // overlay closes itself, the record's add door re-reads its feed, and the Trends
  // page mounts simply reset and stay put.
  onSaved?: () => void;
  // Optional action for a standalone card mount.
  headerSlot?: ReactNode;
  // A metric detail page narrows this shared form to the observation currently
  // being viewed. Omitted on the body census and quick-entry overlay, which keep the
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
  // the other one's open group. Omitted where no memory is wanted. This is a
  // MEMORY key, not a write signal — it is present on every mount, including an
  // ordinary acting-profile one, and answers "whose localStorage group" rather
  // than "is this a cross-profile write." `subjectProfileId` below answers that
  // second question; do not read this field for it (#4932 postmortem).
  profileId?: number;
  // The quick-log sheet's chosen subject (#4932), set ONLY when it differs from
  // the acting profile — distinct from `profileId` above, which is present on
  // every mount for the memory key regardless of subject. This is the one field
  // that means "a non-acting subject was chosen": it gates the offline refusal
  // and is the id stamped as `profile_id` on the write, so `addMeasurements`'s
  // `gateItemProfile` re-gates THAT profile rather than defaulting to the acting
  // one. Omitted (not just falsy) on every mount outside the quick-entry sheet.
  subjectProfileId?: number;
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

// bed_time / wake_time are NOT here (#4976): TimeRangeFields' TimeField mounts hold
// them as controlled React state (bedTime/wakeTime below), the same reason DateField
// hosts never appear in this list either — a controlled field keeps its own value
// across a form action's commit with no pinning trick needed, and resetForm() clears
// it explicitly rather than relying on the DOM's own reset.
const UNCONTROLLED_VITAL_FIELDS = [
  "systolic",
  "diastolic",
  "glucose",
  "spo2",
  "temperature",
  "sleep_hours",
  "hrv",
  "respiratory_rate",
  "peak_flow",
] as const;

export default function MeasurementsQuickAdd({
  defaultDate,
  defaultStatedAt = null,
  maxDate,
  weightUnit,
  temperatureUnit = "F",
  showCompositionEntry = true,
  showGrowth = false,
  showHeadCirc = false,
  onSaved,
  headerSlot,
  metric,
  presentation = "card",
  defaultGroup,
  profileId,
  subjectProfileId,
}: MeasurementsQuickAddProps) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const formRef = useRef<HTMLFormElement>(null);
  // Which surface this sitting was entered on (#3087): the Trends panel, a metric
  // detail page, or the quick-log sheet — three mountings of this one form.
  const stampLoggedVia = useLoggedViaStamp();
  const [error, setError] = useState<string | null>(null);
  // The submission's WHEN — one date + one optional Time for the whole sitting
  // (#2235 decision 3), owned as a PAIR by the shared control so a stated instant's
  // profile-local date is the row's date by construction. Posted through the hidden
  // pair below; the initial statedAt is the seed from the day's existing manual row
  // (or null — the control never defaults it to now).
  const [when, setWhen] = useState<WhenValue>(() => ({
    date: defaultDate,
    statedAt: defaultStatedAt,
  }));
  const tz = useTimezone();
  // The night's two clocks (#1851, #4976), controlled the same way `when` is —
  // `TimeRangeFields` posts them through its own hidden inputs (`bed_time`/
  // `wake_time`, unchanged names), so the write below reads the pair exactly as
  // it always has.
  const [bedTime, setBedTime] = useState("");
  const [wakeTime, setWakeTime] = useState("");
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

  // React resets uncontrolled fields when a form action resolves. Pin the refused
  // vitals as that reset's defaults for a partial save, then restore the ordinary
  // empty/default baseline at the start of the next action (after FormData exists).
  function pinVitalsAcrossActionReset(data?: FormData) {
    const form = formRef.current;
    if (!form) return;
    for (const name of UNCONTROLLED_VITAL_FIELDS) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement) {
        field.defaultValue = data ? String(data.get(name) ?? "") : "";
      }
    }
    const unit = form.elements.namedItem("glucose_unit");
    if (unit instanceof HTMLSelectElement) {
      const selected = data
        ? String(data.get("glucose_unit") ?? "mg/dL")
        : "mg/dL";
      for (const option of unit.options) {
        option.defaultSelected = option.value === selected;
      }
    }
  }

  // The detail page applies this before rendering its Log Manually trigger. Keep
  // the form guarded too so a future mounting context cannot bypass the gates.
  if (
    metric &&
    !isMeasurementEntryAllowed(metric.key, {
      showCompositionEntry,
      showGrowth,
      showHeadCirc,
    })
  ) {
    return null;
  }

  async function handle(formData: FormData) {
    pinVitalsAcrossActionReset();
    setError(null);
    const s = (k: string): string | null => {
      const v = formData.get(k);
      return v === null || String(v).trim() === "" ? null : String(v);
    };
    const date = String(formData.get("date") ?? "").trim();
    // #4932: the quick-log sheet's subject chip mounts this SAME form cross-profile.
    // `subjectProfileId` present means a non-acting subject was chosen; stamp it
    // so `addMeasurements`'s `gateItemProfile` re-gates THAT profile rather than
    // defaulting to the acting one. NOT `profileId` — that field is present on
    // every mount (it is the memory-key scope) and would stamp an explicit
    // subject onto an ordinary acting-profile write.
    if (subjectProfileId != null)
      formData.set("profile_id", String(subjectProfileId));

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
      sleepHours: s("sleep_hours"),
      bedTime: s("bed_time"),
      wakeTime: s("wake_time"),
      hrv: s("hrv"),
      respiratoryRate: s("respiratory_rate"),
      peakFlow: s("peak_flow"),
    };
    const growth = {
      height: s("height"),
      heightUnit: s("height_unit"),
      headCirc: s("head_circ"),
      headCircUnit: s("head_circ_unit"),
    };
    const waist = {
      waistCirc: s("waist_circ"),
      waistCircUnit: s("waist_circ_unit"),
    };
    const composition = {
      leanMass: s("lean_mass"),
      leanMassUnit: s("lean_mass_unit"),
      boneMass: s("bone_mass"),
      boneMassUnit: s("bone_mass_unit"),
      hydration: s("hydration"),
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
      vitals.bedTime != null ||
      vitals.wakeTime != null ||
      vitals.hrv != null ||
      vitals.respiratoryRate != null ||
      vitals.peakFlow != null;
    const hasGrowth = growth.height != null || growth.headCirc != null;
    const hasWaist = waist.waistCirc != null;
    const hasComposition =
      composition.leanMass != null ||
      composition.boneMass != null ||
      composition.hydration != null;

    if (!hasBody && !hasVitals && !hasGrowth && !hasWaist && !hasComposition) {
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
      (hasGrowth ? validateGrowthInput(growth) : null) ??
      (hasWaist ? validateWaistInput(waist) : null) ??
      (hasComposition ? validateCompositionInput(composition) : null);
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
    // sample-only offline case never reach here.
    const rememberWritten = (): void => {
      if (written) rememberGroup(profileId, written);
    };
    const resetForm = (): void => {
      const form = formRef.current;
      if (!form) return;
      const waistField = form.elements.namedItem("waist_circ");
      if (waistField instanceof HTMLInputElement) waistField.defaultValue = "";
      const waistUnit = form.elements.namedItem("waist_circ_unit");
      if (waistUnit instanceof HTMLSelectElement) {
        for (const option of waistUnit.options) option.defaultSelected = false;
        waistUnit.options[0].defaultSelected = true;
      }
      form.reset();
      // form.reset() only reaches uncontrolled fields — the night's two clocks are
      // React state now (#4976) and clear themselves here instead.
      setBedTime("");
      setWakeTime("");
    };
    const clearQueuedBodyFields = (): void => {
      const form = formRef.current;
      if (!form) return;
      for (const name of ["weight", "body_fat_pct", "resting_hr", "notes"]) {
        const field = form.elements.namedItem(name);
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement
        ) {
          field.value = "";
        }
      }
    };

    // Offline: replay each half through its OWN queued intent — the queue's flow
    // kinds are the write cores, and this form is a composition of them, not a new
    // kind. Growth, composition, and waist-only entries remain unqueueable; when a
    // waist accompanies body metrics, the body intent can still be kept (#4142).
    //
    // "refused" is the device declining the capture (#3038): nothing will sync,
    // so the caller says the shared sentence and every success step — the toast,
    // the group memory, the summaries refresh — is skipped. The refusal causes
    // are device-wide (no storage to queue into, or this device was logged out),
    // so in practice the two halves refuse together — and the first refusal
    // stops the second enqueue rather than queueing half a sitting under a toast
    // that says none of it was saved.
    //
    // "partial" is the narrow case that survives that rule (#3118): storage failing
    // BETWEEN the two enqueues, so the body half is kept and the vitals half is not.
    // It is a refusal — no success toast, no reset, no group memory — but it is not
    // the shared sentence, because the weight WILL sync and telling someone it did
    // not is what makes them log it twice.
    //
    // WHICH IS ONLY TRUE OF ONE OF THE TWO CAUSES, and that is why the queue answers
    // with a cause rather than a boolean. A "failed" vitals half (the quota edge) leaves
    // the body intent sitting in the store. A "closed" one does not: the gate is closed
    // only by `clearQueue`, which clears the intents store in the SAME transaction (see
    // lib/offline/write-gate.ts), so a logout landing in the gap took the body half with
    // it. Claiming "Body measurements were saved" there tells the person to re-enter only
    // the vitals and silently loses the weigh-in — a worse trade than the duplicate this
    // sentence exists to prevent. So a close falls back to the shared sentence, which is
    // then simply true: nothing is queued and no badge says otherwise.
    const queueOffline = async (): Promise<
      "queued" | "refused" | "partial" | "partial-waist" | "unqueueable"
    > => {
      if (hasGrowth || hasComposition || (hasWaist && (!hasBody || hasVitals)))
        return "unqueueable";
      let keptBody = false;
      if (hasBody) {
        const kept = await enqueue("body-metric", date, {
          weight: String(body.weight ?? ""),
          weightUnit,
          bodyFatPct: body.bodyFatPct,
          restingHr: body.restingHr,
          notes: body.notes,
          // The sitting's stated time travels with the queued intent (#2235):
          // an offline weigh-in keeps its statement, and an explicitly-empty
          // Time still clears — same trichotomy the online action posts.
          occurredAt: s("occurred_at"),
        });
        if (kept !== "kept") return "refused";
        keptBody = true;
      }
      if (hasWaist) {
        const form = formRef.current;
        const waistField = form?.elements.namedItem("waist_circ");
        if (waistField instanceof HTMLInputElement) {
          waistField.defaultValue = String(waist.waistCirc);
        }
        const waistUnit = form?.elements.namedItem("waist_circ_unit");
        if (waistUnit instanceof HTMLSelectElement) {
          for (const option of waistUnit.options) {
            option.defaultSelected = option.selected;
          }
        }
        rememberWritten();
        return "partial-waist";
      }
      if (hasVitals) {
        // The sitting's one stated time travels with the vitals intent too
        // (#2154): a queued evening BP keeps its statement, and an explicitly
        // empty Time replays as "no time" — the same trichotomy the online
        // action reads off the same hidden field.
        const kept = await enqueue("vitals", date, {
          ...vitals,
          occurredAt: s("occurred_at"),
        });
        if (kept !== "kept") {
          if (keptBody && kept === "failed") {
            // The body intent is durable but the vitals are not. Keep the refused
            // half (and its shared date/time) ready for retry while removing every
            // field another body intent would duplicate (#3830).
            clearQueuedBodyFields();
            pinVitalsAcrossActionReset(formData);
            rememberWritten();
            refreshSummaries();
            return "partial";
          }
          return "refused";
        }
      }
      rememberWritten();
      toast("Saved offline — will sync when you reconnect.");
      resetForm();
      tempUnitDetection.reset();
      refreshSummaries();
      return "queued";
    };

    // The queue is stamped to the acting profile and carries no subject (same as
    // MoodForm's identical guard) — a non-acting subject's save must fail honestly
    // offline rather than queue a write that could replay onto somebody else.
    // `subjectProfileId`, not `profileId`: the latter is set on every mount (the
    // memory-key scope) and would refuse the acting profile's own offline save.
    if (
      subjectProfileId != null &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      setError("You're offline — reconnect to save these measurements.");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const captured = await queueOffline();
      if (captured === "queued") return;
      if (captured !== "unqueueable") {
        toast(refusedMessage(captured), { tone: "error" });
        return;
      }
      setError("You're offline — reconnect to save these measurements.");
      return;
    }
    let saved: MeasurementsSaveResult;
    try {
      saved = await addMeasurements(stampLoggedVia(formData));
    } catch (err) {
      if (
        subjectProfileId == null &&
        shouldQueueOffline(navigator.onLine !== false, err)
      ) {
        const captured = await queueOffline();
        if (captured === "queued") return;
        if (captured !== "unqueueable") {
          toast(refusedMessage(captured), { tone: "error" });
          return;
        }
      }
      setError("Couldn't save these measurements. Try again.");
      return;
    }
    // NOTHING LANDED (#4425). The one refusal this action can answer with, and it has
    // to reach the person: the form's own date field can be set to a day that has not
    // happened, every write core refuses it, and the ordinary path below would toast
    // "Measurements saved" and reset over an empty table. Inline, like every other
    // refusal here — the entry is still on screen to correct.
    if (saved.dateRefused) {
      setError("That date hasn't happened yet. Pick today or an earlier day.");
      return;
    }
    rememberWritten();
    // The measurements landed; the sitting's stated time may not have (#2311). That
    // is a NOTICE on the ordinary success toast — never `setError`, which would read
    // as "your entry failed" for a reading that is sitting right there — and never a
    // durable marker to chase the user with later.
    toast(
      measurementsSavedText(
        metric ? `${metric.label} saved` : "Measurements saved",
        saved.statedTimeRefused,
        saved.sleepWindowRefused
      )
    );
    resetForm();
    tempUnitDetection.reset();
    refreshSummaries();
    onSaved?.();
  }

  // ── The fields, authored once and GROUPED below ─────────────────────────────
  // A label names the measure, the field carries its unit, and the group heading
  // carries the domain — so no label appends a second parenthetical to a title that
  // already has one ("BLOOD PRESSURE (SYSTOLIC) (MMHG)", uppercased by `.label`).
  // The mass toggle leads with the login's own weight unit, so the common case is
  // one tap fewer and the uncommon one is still there. Storage is canonical kg
  // either way; the CHART stays in kilograms, exactly as height charts in
  // centimetres however the tape was read.
  const massUnitOptions = weightUnit === "lb" ? ["lb", "kg"] : ["kg", "lb"];

  const field = {
    weight: (
      <Field
        key="weight"
        label={TREND_METRIC_META.weight.title}
        htmlFor="m-weight"
      >
        {/* THE DOMAIN'S ONE WEIGHT FIELD (#4424 ruling 5) — the pediatric label
            lookup composes this same component, so a weight typed there and one
            typed here are the same field rather than two arrangements of it. */}
        <WeightField id="m-weight" unit={weightUnit} />
      </Field>
    ),
    bodyFat: (
      <Field
        key="body-fat"
        label={TREND_METRIC_META["body-fat"].title}
        htmlFor="m-body-fat"
      >
        <UnitSuffix suffix={TREND_METRIC_META["body-fat"].unit}>
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
        label={TREND_METRIC_META.height.title}
        htmlFor="m-height"
      >
        <UnitToggle
          name="height_unit"
          label={`${TREND_METRIC_META.height.title} unit`}
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
        label={TREND_METRIC_META["head-circ"].title}
        htmlFor="m-head-circ"
      >
        <UnitToggle
          name="head_circ_unit"
          label={`${TREND_METRIC_META["head-circ"].title} unit`}
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
    // Waist circumference (#2322) — the tape reading the ruling rests on. Same cm/in
    // toggle as its two length neighbours, and ungated: an adult profile renders no
    // height field but every profile can measure a waist.
    waistCirc: (
      <Field
        key="waist-circ"
        label={TREND_METRIC_META["waist-circ"].title}
        htmlFor="m-waist-circ"
      >
        <UnitToggle
          name="waist_circ_unit"
          label={`${TREND_METRIC_META["waist-circ"].title} unit`}
          options={["cm", "in"]}
        >
          <input
            id="m-waist-circ"
            type="number"
            step="0.1"
            min="0"
            name="waist_circ"
            data-testid="measurements-waist-circ"
            className="input pr-16"
          />
        </UnitToggle>
      </Field>
    ),
    // Lean and bone mass (#1851) — the two numbers a DEXA report hands you, and
    // the reason the protein band could not use the basis it prefers. Entered in
    // the login's own weight unit (the toggle leads with it) and stored in
    // canonical kilograms, the same rows Withings and Health Connect write.
    leanMass: (
      <Field
        key="lean-mass"
        label={TREND_METRIC_META["lean-mass"].title}
        htmlFor="m-lean-mass"
      >
        <UnitToggle
          name="lean_mass_unit"
          label={`${TREND_METRIC_META["lean-mass"].title} unit`}
          options={massUnitOptions}
        >
          <input
            id="m-lean-mass"
            type="number"
            step="0.1"
            min="0"
            name="lean_mass"
            data-testid="measurements-lean-mass"
            className="input pr-16"
          />
        </UnitToggle>
      </Field>
    ),
    boneMass: (
      <Field
        key="bone-mass"
        label={TREND_METRIC_META["bone-mass"].title}
        htmlFor="m-bone-mass"
      >
        <UnitToggle
          name="bone_mass_unit"
          label={`${TREND_METRIC_META["bone-mass"].title} unit`}
          options={massUnitOptions}
        >
          <input
            id="m-bone-mass"
            type="number"
            step="0.01"
            min="0"
            name="bone_mass"
            className="input pr-16"
          />
        </UnitToggle>
      </Field>
    ),
    hydration: (
      <Field key="hydration" label="Water today" htmlFor="m-hydration">
        <UnitSuffix suffix={TREND_METRIC_META.hydration.unit.trim()}>
          <input
            id="m-hydration"
            type="number"
            step="0.1"
            min="0"
            name="hydration"
            data-testid="measurements-hydration"
            className="input pr-9"
          />
        </UnitSuffix>
      </Field>
    ),
    // A blood pressure is ONE reading typed as two numbers — one field, two inputs
    // and a slash. Adjacency used to be an ordering convention against a grid that
    // reflows freely; here it is structural.
    //
    // AND IT IS THE ONE CELL THAT HOLDS TWO CONTROLS, so it takes two tracks
    // (#4977 item 2). A track is sized for one input; splitting one between two of
    // them plus a slash and a unit left each under the length of its own
    // placeholder, which then truncated mid-word — the field said "Sy" and "Dia"
    // where it means systolic and diastolic. Two tracks give each input a track's
    // room at every host width, and the placeholders can say the words.
    bloodPressure: (
      <Field
        key="blood-pressure"
        label="Blood Pressure"
        htmlFor="m-systolic"
        tracks={2}
      >
        <div className="flex items-center gap-1.5">
          <input
            id="m-systolic"
            type="number"
            step="1"
            min="0"
            name="systolic"
            aria-label="Systolic"
            placeholder="Systolic"
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
            placeholder="Diastolic"
            className="input min-w-0 flex-1"
          />
          <span className="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
            {TREND_METRIC_META.systolic.unit.trim()}
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
      <Field key="spo2" label={TREND_METRIC_META.spo2.title} htmlFor="m-spo2">
        <UnitSuffix suffix={TREND_METRIC_META.spo2.unit}>
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
    // WHEN a temperature was taken is the sitting's one Time (the shared
    // WhenControl above the groups) — the per-measure time input folded into it
    // (#2154), and the write boundary lands the statement on the row's own
    // occurred_at, keeping the #800/#843 fever curve keyed by real instants.
    temperature: (
      <Field
        key="temperature"
        label={TREND_METRIC_META.temperature.title}
        htmlFor="m-temperature"
      >
        {/* THE DOMAIN'S ONE TEMPERATURE FIELD (#4424 ruling 5) — the symptom bar's
            illness mounts compose this same component, so a reading typed there and
            one typed here are the same field rather than two arrangements of it. */}
        <TemperatureField
          id="m-temperature"
          testIdPrefix="m-temp"
          detection={tempUnitDetection}
          unitLabel={`${TREND_METRIC_META.temperature.title} unit`}
        />
      </Field>
    ),
    // The night's two clocks (#1851) — ONE reading typed as two times, the same
    // structural pairing a blood pressure gets. This is the whole of what the Sleep
    // Regularity Index needs; the hours field below cannot give it, because a
    // duration says nothing about WHEN.
    //
    // TimeRangeFields in its `overnight` mode (#4976 item 2): a bed time is always
    // followed, never preceded, by its wake, so a wake clock earlier than bed means
    // the next day rather than a refusal. The pair's own two labels ("Bed time" /
    // "Wake time", the issue's own ruling) replace the outer "Bed & wake" label this
    // Field used to draw — `e2e/manual-vitals.spec.ts` locates them by those labels
    // either way, so its locators are untouched. `col-span-2`: this grid's own
    // per-field column is 10.5rem at its narrowest (`GRID_CLASS` below), too tight
    // for two styled clocks side by side — the two native inputs this replaces
    // didn't need the room a real text input plus its picker button does.
    sleepWindow: (
      <div key="sleep-window" className="col-span-2 min-w-0">
        <TimeRangeFields
          idPrefix="m-sleep"
          startTime={bedTime}
          endTime={wakeTime}
          tz={tz}
          timeError={false}
          derivableDurationMin={null}
          startName="bed_time"
          endName="wake_time"
          startLabel="Bed time"
          endLabel="Wake time"
          overnight
          onStartTime={setBedTime}
          onEndTime={setWakeTime}
        />
      </div>
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
    respiratoryRate: (
      <Field
        key="respiratory-rate"
        label={TREND_METRIC_META["respiratory-rate"].title}
        htmlFor="m-respiratory-rate"
      >
        <UnitSuffix suffix={TREND_METRIC_META["respiratory-rate"].unit.trim()}>
          <input
            id="m-respiratory-rate"
            type="number"
            step="1"
            min="0"
            name="respiratory_rate"
            data-testid="measurements-respiratory-rate"
            className="input pr-12"
          />
        </UnitSuffix>
      </Field>
    ),
    hrv: (
      <Field key="hrv" label={TREND_METRIC_META.hrv.title} htmlFor="m-hrv">
        <UnitSuffix suffix={TREND_METRIC_META.hrv.unit.trim()}>
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
        label={TREND_METRIC_META["peak-flow"].title}
        htmlFor="m-peak-flow"
      >
        <UnitSuffix suffix={TREND_METRIC_META["peak-flow"].unit.trim()}>
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
        {/* Peak flow is monitored once or twice a day during a flare (#1850), so
            the blow carries a clock time — the sitting's one Time above (#2154's
            fold), which is what lets an evening reading join the morning's
            instead of correcting it. */}
      </Field>
    ),
    restingHr: (
      <Field
        key="resting-hr"
        label={TREND_METRIC_META["resting-hr"].title}
        htmlFor="m-resting-hr"
      >
        <UnitSuffix suffix={TREND_METRIC_META["resting-hr"].unit.trim()}>
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
    "waist-circ": [field.waistCirc],
    "respiratory-rate": [field.respiratoryRate],
    "lean-mass": [field.leanMass],
    "bone-mass": [field.boneMass],
    hydration: [field.hydration],
  };

  const groupFields: Record<MeasurementGroup, ReactNode[]> = {
    vitals: [
      field.bloodPressure,
      field.restingHr,
      field.spo2,
      field.respiratoryRate,
      field.temperature,
      field.glucose,
      field.peakFlow,
    ],
    body: [
      field.weight,
      ...(showCompositionEntry ? [field.bodyFat] : []),
      ...(showGrowth ? [field.height] : []),
      ...(showGrowth && showHeadCirc ? [field.headCirc] : []),
      field.waistCirc,
      // The composition class travels together (#4147): lean and bone mass come off
      // the same DEXA reading as the body fat above, so offering two of the three read
      // as an oversight. The tape and the day's water either side stay ungated.
      ...(showCompositionEntry ? [field.leanMass, field.boneMass] : []),
      field.hydration,
    ],
    sleep: [field.sleepWindow, field.sleep, ...(showHrv ? [field.hrv] : [])],
  };

  // ONE sentence for what this form is (#4977 item 3): the same string whichever
  // presentation renders it, and whichever mount is rendering.
  const about = metric
    ? `Add one manual ${metric.label.toLowerCase()} reading. It will appear alongside synced readings.`
    : "Today’s body and vitals readings — fill in only what you measured. Shows up alongside synced readings.";

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
      {/* WHAT THE FORM IS FOR, AS THE TITLE'S GLYPH (#4977 item 3, on #4918
          ruling 4's precedent). It was a paragraph, and it said the same sentence
          on every visit forever while holding the widest line under the title — the
          shape that rule moves to an info affordance. `about` is authored ONCE and
          read by both branches below; the two hosts used to carry their own copy of
          it, which is how a sentence gets edited in one place and not the other.

          IN A DIALOG THE HEADING IS THE HOST'S (#3361), so the glyph is the whole
          of what this form contributes to that row — a heading of its own here
          would print the panel's name twice, which is the thing #3361 removed. */}
      {presentation === "card" ? (
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-1 font-semibold text-slate-800 dark:text-slate-100">
            {metric ? `Log ${metric.label}` : "Log measurements"}
            <InfoTooltipIcon label={about} data-testid="measurements-help" />
          </h2>
          {headerSlot}
        </div>
      ) : (
        <InfoTooltipIcon label={about} data-testid="measurements-help" />
      )}

      {/* The submission's one date + one optional Time (#2235 decision 3): the
          shared WhenControl owns the pair (ids m-date / m-time from its testId),
          and the hidden pair below is what actually posts — so the Server Action
          and the offline queue read the same two names whatever the control
          renders. The Time never defaults to now (#2053); the control offers a
          one-tap "Now" while the chosen day is today. This ONE Time is the whole
          sitting's statement — #2154 folded the two per-measure time inputs
          (temperature, peak flow) into it, and the write boundary carries it to
          body_metrics and medical_records `occurred_at` and the peak-flow
          sample's own instant alike. */}
      <input type="hidden" name="date" value={when.date} readOnly />
      <input
        type="hidden"
        name="occurred_at"
        value={when.statedAt ?? ""}
        readOnly
      />
      <div>
        <span className="label">Date &amp; time</span>
        <WhenControl
          mode="state"
          grain="minute"
          value={when}
          onChange={setWhen}
          maxDate={maxDate}
          testId="m"
          dateLabel="Date"
          timeLabel="Time taken (optional)"
        />
      </div>
      {metric ? (
        <div className={GRID_CLASS}>{scopedFields[metric.key]}</div>
      ) : null}

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
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-800 hover:bg-black/3 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-100 dark:hover:bg-white/4"
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

      <InlineError>{error}</InlineError>
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
  tracks = 1,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  // How many of the grid's tracks this field's cell takes. One, unless the cell
  // holds more than one control (#4977 item 2). Safe against the intrinsic grid at
  // every width: measured in Chromium, a `span 2` in a container narrow enough to
  // fit a SINGLE `auto-fit` track adds an implicit track that resolves to 0px, so
  // the cell is exactly the container width and nothing escapes it.
  tracks?: 1 | 2;
}) {
  return (
    <div className={tracks === 2 ? "col-span-2 min-w-0" : "min-w-0"}>
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
