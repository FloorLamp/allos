"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteActivity, logBodyweight } from "@/app/(app)/journal/actions";
import type { ActivityType, Equipment } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { isBodyweight, baseLiftName } from "@/lib/lifts";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import { compositeRollup, minutesBetween } from "@/lib/activity-meta";
import { activityTiming } from "@/lib/activity-timing";
import {
  summarizeEquipmentAvailability,
  deRankUnavailableLifts,
} from "@/lib/equipment-availability";
import { round } from "@/lib/units";
import { IconAlertTriangle, IconFlagCheck } from "@tabler/icons-react";
import PlateBuilderModal from "./PlateBuilderModal";
import { isRealIsoDate } from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  type ActivityEditData,
  todayStr,
  nowHHMM,
} from "./activity-form/model";
import {
  makeNameClassifier,
  analyzeActivityForm,
  buildActivityPayload,
  generateActivityTitle,
  resolveFormSessionDuration,
} from "@/lib/activity-form-validate";
import LiveWorkoutPanel from "./activity-form/LiveWorkoutPanel";
import { useActivityAutosave } from "./activity-form/useActivityAutosave";
import { useActivityParts } from "./activity-form/useActivityParts";
import ActivityPartsList from "./activity-form/ActivityPartsList";
import SessionCompleteStep from "./activity-form/SessionCompleteStep";
import { leadExerciseName } from "@/lib/live-workout";
import {
  recapSessionFromPayload,
  sessionRecap,
  type Recap,
} from "@/lib/session-recap";
import ActivityEquipmentPicker from "./activity-form/ActivityEquipmentPicker";
import ActivityFormHeader from "./activity-form/ActivityFormHeader";
import DateTimeFields from "./activity-form/DateTimeFields";
import IntensityPicker from "./activity-form/IntensityPicker";
import ActivityMoreDetails from "./activity-form/ActivityMoreDetails";
import ActivityFormFooter from "./activity-form/ActivityFormFooter";
import {
  equipmentForActivity,
  pickDefaultActivityEquipment,
  usesActivityEquipment,
} from "@/lib/activity-equipment";
import { estimateActivityKcal } from "@/lib/calorie-estimate";
import { activityDisclosureSummary } from "@/lib/activity-import-details";

// Re-exported so existing callers keep importing the edit-payload shape from
// this module; the definition now lives in ./activity-form/model.
export type { ActivityEditData };

// The shared activity create/edit form, rendered inside ActivityOverlay or docked
// in the journal's right column. Either way it auto-saves: changes persist a
// moment after any valid edit (create-then-update), so every way of leaving the
// form — close button, backdrop, Escape, navigation — is loss-free and there is
// no Save/Cancel step.
//
// COMPOSITION, NOT A GOD COMPONENT (#1207 — regrew to ~1,727 lines after #319, now
// re-split). This parent is deliberately kept as ORCHESTRATION over extracted units:
//   • state machines → hooks: useActivityParts (parts/sets + plate builder) and
//     useActivityAutosave (the #1189 debounced-persist / created-row / flush machine).
//   • presentational sections → components/activity-form/*: ActivityFormHeader,
//     ActivityPartsList, DateTimeFields, ActivityMoreDetails, ActivityFormFooter,
//     LiveWorkoutPanel, SessionCompleteStep, PlateBuilderModal.
//   • pure logic → lib/: analyzeActivityForm, buildActivityPayload, sessionRecap,
//     activityTiming, initialPartsFromSeed, plus the model in activity-form-model.
// Before adding a new INLINE field group or a self-contained state machine here,
// extract it into a sibling section/hook instead — keep the parent compositional so
// it can't silently regrow past this point again. The activity e2e specs
// (entry-ergonomics, session-recap, rpe-logging, form-fill-paths) are the regression
// net for that refactoring.
export default function ActivityForm({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  editData,
  prefill = null,
  live = false,
  deloadContext,
  recoveringContext = { temperedRegions: [] },
  plateauHints = [],
  onClose,
  stickyFooter = false,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  // Recently-used session gear, most-recent-first (issues #342/#339) — defaults the
  // activity-level equipment picker on a new non-strength log. The form narrows it
  // per-activity (last-used shoes for a run, last-used bike for a ride).
  recentActivityEquipment?: number[];
  bodyweightKg: number | null;
  editData: ActivityEditData | null;
  // "Log again" / "Repeat last" seed (issue #29): pre-fills the form's initial
  // state (title, exercises, sets) exactly like editData, but the form still
  // treats it as a CREATE — saves insert a new activity, and the prefilled
  // content auto-saves on open. Ignored when editData is present.
  prefill?: ActivityEditData | null;
  // Live workout mode (issue #340): opens the create form in the in-gym layout —
  // a control strip with the rest timer + Finish above the normal form. Purely a
  // presentation flag over the same form state (no second engine); "Finish"
  // collapses it back to the plain editor. Ignored in edit mode.
  live?: boolean;
  // Deload/plateau inputs for the strength editor (#923). `deloadContext` shaves the
  // next-set suggestion for a routine lift on a deload week (through the shared
  // deloadAdjust); `plateauHints` renders the calm inline plateau hint.
  deloadContext: FormDeloadContext;
  // The recovering-injury regions the strength editor tempers by (#1144): a lift whose
  // region is returning from a RECOVERING injury (#838) gets the SAME 0.6× temper the
  // Analyze/detail panel seeds, so the live logger and its deep-link target agree on the
  // injury axis (#221/#1115). Composed with the deload shave through contextualNextSet.
  recoveringContext?: FormRecoveringContext;
  plateauHints?: PlateauFormHint[];
  onClose: () => void;
  // In the overlay the (often taller-than-viewport) form scrolls, so the action
  // row pins to the bottom of the screen and gains a Done button — otherwise
  // closing means scrolling back up to the ✕. The docked editor keeps the plain
  // row: sticking to the page viewport there would detach it from the form.
  stickyFooter?: boolean;
}) {
  const router = useRouter();
  const tz = useTimezone();
  // Kept for the unmount-flush failure path: the toast outlives the form.
  const toast = useToast();
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const [saving, setSaving] = useState(false);
  // The row the form's initial state is reconstructed from: a stored row being
  // edited, or a "Log again"/"Repeat last" prefill. In prefill mode this only
  // seeds state — editData stays null, so isEdit/savableId/hasRow all keep their
  // create semantics and the first save inserts a new activity.
  const seed = editData ?? prefill;

  // Bodyweight lifts fold the user's bodyweight into their volume/strength stats.
  // If none is on record, prompt for it inline (saved as a body-metrics entry).
  const [bwKnown, setBwKnown] = useState(bodyweightKg != null);
  const [bwInput, setBwInput] = useState("");
  const [bwSaving, setBwSaving] = useState(false);

  const { allOptions, typeByName } = useMemo(() => {
    const m = new Map<string, ActivityType>();
    for (const n of suggestions.sports) m.set(n.toLowerCase(), "sport");
    for (const n of suggestions.cardio) m.set(n.toLowerCase(), "cardio");
    for (const n of suggestions.lifts) m.set(n.toLowerCase(), "strength");
    const all = [
      ...new Set([
        ...suggestions.lifts,
        ...suggestions.cardio,
        ...suggestions.sports,
      ]),
    ];
    return { allOptions: all, typeByName: m };
  }, [suggestions]);

  // All name→type classification (partType, distance-field, custom flags) is
  // pure logic keyed off the picker vocabulary — built once here and destructured
  // so the inline call sites below stay unchanged (see lib/activity-form-validate).
  const classifier = useMemo(
    () => makeNameClassifier(typeByName),
    [typeByName]
  );
  const { partType, partNeedsDistance, isKnown, customFlags } = classifier;

  // Local copy so a bar created from the plate builder appears immediately in
  // both the equipment selector and the builder without waiting on a refetch.
  const [equipmentList, setEquipmentList] = useState<Equipment[]>(equipment);

  // Equipment-aware base ordering for the exercise combobox (issue #345): de-rank
  // lifts whose implement kind the profile doesn't own, so cold suggestions prefer
  // gear the user actually has. A no-op for an empty registry (gym-goers), and only
  // a BASE reorder — the companion/recency bias below still floats logged lifts, so
  // this mostly affects untrained cold suggestions ("de-rank, not hide").
  const equipmentRankedOptions = useMemo(
    () =>
      deRankUnavailableLifts(
        allOptions,
        summarizeEquipmentAvailability(equipmentList)
      ),
    [allOptions, equipmentList]
  );

  // Session-level equipment link (issue #342): the gear the WHOLE activity used —
  // a ride's bike, a run's shoes — distinct from the per-set strength implement.
  // Seeded from a stored/edited (or prefilled) row; on a fresh non-strength log it
  // auto-defaults to the last-used gear for that type (the effect below), mirroring
  // the strength picker's recency. `equipmentTouchedRef` records an explicit user
  // choice so the auto-default never overrides it (incl. an intentional "None").
  const [activityEquipmentId, setActivityEquipmentId] = useState<number | null>(
    seed?.equipment_id ?? null
  );
  const equipmentTouchedRef = useRef(false);

  // Lazy initializers: the fallbacks format dates, no need to redo that work on
  // every render just to discard it.
  const [date, setDate] = useState(() => seed?.date ?? todayStr(tz));
  const [startTime, setStartTime] = useState(() =>
    editData ? (editData.start_time ?? "") : nowHHMM(tz)
  );
  const [endTime, setEndTime] = useState(editData?.end_time ?? "");
  const [sessionDuration, setSessionDuration] = useState(() =>
    seed?.duration_min != null ? String(Math.round(seed.duration_min)) : ""
  );
  const [intensity, setIntensity] = useState(seed?.intensity ?? "");
  const [notes, setNotes] = useState(seed?.notes ?? "");
  // Estimated calories (issue #151): the field auto-fills from the MET dataset ×
  // this profile's bodyweight × duration, and stays editable so the user can
  // override it. An override (or an edit of a manual row that already saved one)
  // sets estEdited, which pins the field against further auto-fill. Kept as a
  // string so an empty field round-trips (clears the stored estimate).
  const [estCalories, setEstCalories] = useState<string>(() =>
    seed?.est_calories != null ? String(Math.round(seed.est_calories)) : ""
  );
  const [estEdited, setEstEdited] = useState<boolean>(
    seed?.est_calories != null
  );
  // Editable activity name. For new activities it tracks the auto-generated
  // title until the user types their own; for edits (and repeat prefills) it
  // keeps the seeded title.
  const [title, setTitle] = useState(seed?.title ?? "");
  const [titleEdited, setTitleEdited] = useState(!!seed);
  const [moreDetailsOpen, setMoreDetailsOpen] = useState<boolean>(
    () =>
      !!seed?.notes ||
      seed?.est_calories != null ||
      (editData?.source != null && editData.imported_metrics != null) ||
      editData?.route_polyline != null
  );

  const isEdit = !!editData;
  // Live workout mode (issue #340) — a create-only presentation. Held as state so
  // "Finish workout" can collapse it back to the plain form. `restStartKey` bumps
  // on every set check-off to auto-start the rest timer.
  const [liveMode, setLiveMode] = useState(live && !isEdit);
  const [restStartKey, setRestStartKey] = useState(0);
  // The live-mode "Session complete" step (#924): Finish opens the recap step
  // instead of collapsing straight to the plain form. It's the ONLY live-gated
  // renderer — reachable only from the live panel's Finish, so retro/plain-form
  // logging and edits never see it.
  const [showRecap, setShowRecap] = useState(false);

  // The parts/sets state machine (#1207 extraction): the `parts` list + plate-builder
  // target and every mutation over them (name/variant resolution, set + part CRUD,
  // suggestion/repeat fills, the plate round-trip). The parent stays composition over
  // this hook plus the auto-save hook and the presentational sections.
  const activityParts = useActivityParts({
    seed,
    units,
    history,
    isEdit,
    equipmentList,
    isKnown,
    customFlags,
    // A set check-off starts the live-mode rest timer (#340).
    onSetCheckedOff: () => {
      if (liveMode) setRestStartKey((n) => n + 1);
    },
  });
  const {
    parts,
    setParts,
    plateTarget,
    setPlateTarget,
    updatePart,
    updatePartName,
    typePartName,
    pickPartName,
    updateSet,
    addSet,
    movePart,
    removeSet,
    removePart,
    addPart,
    applySuggestion,
    fillFromSession,
    applyPerSideSuggestion,
    plateFromSuggestion,
    applyPlateBuild,
  } = activityParts;

  const liveLeadExercise = leadExerciseName(parts.map((p) => p.name));
  function finishWorkout() {
    if (!endTime) setEndTime(nowHHMM(tz));
    setLiveMode(false);
    setShowRecap(false);
  }
  // All validation/auto-save gating (namedParts, canSave, the per-part fault,
  // the save-blocker message, canAddPart) is pure — computed from the parts +
  // session fields by lib/activity-form-validate. partIssue keeps its call
  // signature via the returned partFault.
  const analysis = analyzeActivityForm(classifier, {
    parts,
    startTime,
    endTime,
    date,
  });
  const {
    namedParts,
    timeError,
    dateError,
    canSave: baseCanSave,
    canAddPart,
  } = analysis;
  const partIssue = analysis.partFault;

  // The activity-level equipment picker (issue #342) applies only to NON-strength
  // sessions (strength gear is per-set). It's driven by the first non-strength named
  // part — its TYPE picks the gear kinds and, for cardio, its NAME narrows further
  // (issue #339): a run offers shoes, a ride offers bikes, generic gear for sports.
  // A pure-strength activity has none, so the picker is hidden and no link is saved.
  const sessionEquipmentPart =
    namedParts.find((p) => {
      const t = partType(p);
      return t != null && usesActivityEquipment(t);
    }) ?? null;
  const sessionEquipmentType: ActivityType | null = sessionEquipmentPart
    ? partType(sessionEquipmentPart)
    : null;
  const sessionEquipmentName = sessionEquipmentPart?.name ?? null;
  // Recency default: on a fresh non-strength log (never on an edit), seed the picker
  // with the most-recent gear that's a valid candidate for THIS activity — narrowed
  // by equipmentForActivity, so a run picks up the last-used shoes and a ride the
  // last-used bike — but only while the user hasn't chosen (pickDefaultActivityEquipment).
  useEffect(() => {
    if (editData) return;
    if (equipmentTouchedRef.current || sessionEquipmentType == null) return;
    const candidates = equipmentForActivity(
      equipmentList,
      sessionEquipmentType,
      sessionEquipmentName
    );
    const def = pickDefaultActivityEquipment(
      candidates,
      recentActivityEquipment
    );
    if (def != null) setActivityEquipmentId((cur) => cur ?? def);
  }, [
    editData,
    sessionEquipmentType,
    sessionEquipmentName,
    equipmentList,
    recentActivityEquipment,
  ]);

  const liveTitle = generateActivityTitle(startTime, namedParts, classifier);
  // The name actually saved/shown: the user's title, else the generated one.
  const effectiveTitle = title.trim() || liveTitle;
  // Until the user edits the title, keep it following the generated one.
  useEffect(() => {
    if (!titleEdited) setTitle(liveTitle === "New activity" ? "" : liveTitle);
  }, [liveTitle, titleEdited]);
  const overallDuration =
    startTime && endTime && !timeError
      ? minutesBetween(startTime, endTime)
      : null;
  const enteredSessionDuration = (() => {
    const value = Number(sessionDuration);
    return Number.isFinite(value) && value > 0 ? value : null;
  })();
  const hasStrengthPart = namedParts.some(
    (part) => partType(part) === "strength"
  );
  const explicitComponentDuration = namedParts.reduce((total, part) => {
    if (partType(part) === "strength" || !part.durationMin.trim()) return total;
    const value = Number(part.durationMin);
    return Number.isFinite(value) && value > 0 ? total + value : total;
  }, 0);
  const effectiveSessionDuration = resolveFormSessionDuration({
    clockDuration: overallDuration,
    standaloneDuration: enteredSessionDuration,
    componentDuration:
      explicitComponentDuration > 0 ? explicitComponentDuration : null,
    hasStrength: hasStrengthPart,
  });
  const durationError =
    hasStrengthPart &&
    effectiveSessionDuration != null &&
    explicitComponentDuration > effectiveSessionDuration;
  const canSave = baseCanSave && !durationError;
  // Preserve the most recent complete clock-derived duration as the standalone
  // fallback if one of the clock fields is later removed.
  useEffect(() => {
    if (overallDuration != null)
      setSessionDuration(String(Math.round(overallDuration)));
  }, [overallDuration]);
  // A lone cardio/sport part (no strength, no other leg) auto-SETS its Duration
  // from the clock span (#791) — mirroring the strength session-total precedent
  // above, so the value LANDS on the component (editable) instead of only teasing
  // a placeholder that never saves. Sports are duration-only, so an unfilled leg
  // aggregated as a 0-minute session and showed nothing. Only fires when the
  // field is still empty (never stomps a typed per-leg value) and only for a
  // sole non-strength part: a multi-part composite keeps manual per-leg durations
  // (the same guard buildActivityPayload's save-time fill uses).
  const soleNonStrengthPart =
    namedParts.length === 1 && partType(namedParts[0]) !== "strength"
      ? namedParts[0]
      : null;
  useEffect(() => {
    if (!soleNonStrengthPart || overallDuration == null) return;
    if (soleNonStrengthPart.durationMin.trim()) return;
    const filled = String(Math.round(overallDuration));
    setParts((prev) =>
      prev.map((p) =>
        p === soleNonStrengthPart ? { ...p, durationMin: filled } : p
      )
    );
  }, [soleNonStrengthPart, overallDuration, setParts]);
  // A cardio/sport part's own Duration (min), used to derive End from Start (or
  // Start from End) when the clock span is missing (#336). First such part wins.
  const componentDurationMin = (() => {
    const p = namedParts.find(
      (pp) => partType(pp) !== "strength" && pp.durationMin.trim()
    );
    const n = p ? Number(p.durationMin) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const derivableDurationMin = hasStrengthPart
    ? (enteredSessionDuration ?? componentDurationMin)
    : componentDurationMin;
  const firstValid = namedParts[0];
  const headingType = firstValid ? partType(firstValid) : null;

  // Live multisport roll-up (issue #337): Σ distance / Σ duration across the legs
  // while editing a brick, so the totals don't only appear after save. Fed the
  // display-unit numbers through the SAME compositeRollup the save-time fold uses
  // (lib/activity-meta), so the shown total can't fork from the stored one. Only
  // meaningful once there are ≥2 legs carrying a distance/duration.
  const rollup = compositeRollup(
    namedParts.map((p) => ({
      type: partType(p)!,
      distance_km:
        partNeedsDistance(p) && p.distance.trim() ? Number(p.distance) : null,
      duration_min: p.durationMin.trim() ? Number(p.durationMin) : null,
    })),
    effectiveSessionDuration,
    overallDuration
  );
  const showRollup =
    namedParts.length >= 2 &&
    (rollup.distanceKm != null || rollup.durationMin != null);

  // The formalized active·elapsed split (#1202), through the ONE model every surface
  // reads — shown only when the wall-clock span genuinely exceeds the active/moving
  // total (a paused run, a brick's transitions), so the user sees "45 active · 60
  // elapsed (15 rest)" instead of one ambiguous number.
  const sessionTiming = activityTiming({
    durationMin: rollup.durationMin,
    elapsedMin: rollup.elapsedMin,
    startTime,
    endTime,
  });
  const showTimeBreakdown =
    sessionTiming.activeMin != null &&
    sessionTiming.restMin != null &&
    sessionTiming.restMin > 0;

  // Auto-computed calorie ESTIMATE for this (manual) draft: the MET dataset × this
  // profile's bodyweight × the activity's duration (issue #151). null when there's
  // no bodyweight on record, no usable duration, or nothing valid entered yet — the
  // field then stays empty rather than showing a fabricated number.
  const autoEstimateKcal = useMemo(() => {
    if (bodyweightKg == null || namedParts.length === 0) return null;
    const { comps, primaryType } = buildActivityPayload(
      classifier,
      namedParts,
      overallDuration
    );
    return estimateActivityKcal(
      {
        type: primaryType,
        title: effectiveTitle,
        intensity: intensity || null,
        duration_min: effectiveSessionDuration,
        components: comps.length ? JSON.stringify(comps) : null,
        source: null,
      },
      bodyweightKg
    );
  }, [
    bodyweightKg,
    namedParts,
    classifier,
    effectiveTitle,
    intensity,
    effectiveSessionDuration,
    overallDuration,
  ]);
  // Keep the field tracking the auto-estimate until the user types their own.
  useEffect(() => {
    // Auto-fill is create-only. On an existing row (manual or imported), changing
    // this state merely because the editor opened would dirty the autosave
    // signature and stamp an edit even though the user changed nothing. Existing
    // manual rows display the live value through displayedEstCalories below;
    // imported energy stays read-only in imported_metrics.
    if (editData) return;
    if (estEdited) return;
    setEstCalories(autoEstimateKcal != null ? String(autoEstimateKcal) : "");
  }, [autoEstimateKcal, editData, estEdited]);
  const displayedEstCalories =
    !estEdited && !estCalories.trim() && autoEstimateKcal != null
      ? String(autoEstimateKcal)
      : estCalories;
  const displayedCalories = Number(displayedEstCalories);

  // Build the FormData saveActivity expects from the current state. Callers gate
  // on `canSave` first. `savedId` is the live row id (existing or auto-created),
  // supplied by the auto-save machine so saves update in place rather than
  // inserting duplicates.
  function buildFormData(savedId: number | null): FormData {
    const { comps, flat, primaryType } = buildActivityPayload(
      classifier,
      namedParts,
      overallDuration
    );

    const fd = new FormData();
    if (savedId != null) fd.set("id", String(savedId));
    // Multi-view (#1330): a merged EDIT card carries its subject's profile id, so the
    // save targets the SUBJECT's profile (gateItemProfile → requireProfileWriteAccess).
    // Absent on a single-view edit and on every create/repeat prefill (which write to
    // the acting profile), so those keep the requireWriteAccess fallback.
    if (editData?.subjectProfileId != null)
      fd.set("profile_id", String(editData.subjectProfileId));
    // Carry the unit each weight/distance was CAPTURED in (issue #630) so the
    // action converts with the render-time unit, not whatever the login's stored
    // pref happens to be when this (possibly long-debounced) auto-save lands.
    fd.set("weight_unit", units.weightUnit);
    fd.set("distance_unit", units.distanceUnit);
    fd.set("type", primaryType);
    fd.set("title", effectiveTitle);
    fd.set("date", date);
    fd.set("components", JSON.stringify(comps));
    fd.set("sets", JSON.stringify(flat));
    if (notes.trim()) fd.set("notes", notes.trim());
    if (startTime) fd.set("start_time", startTime);
    if (endTime) fd.set("end_time", endTime);
    if (intensity) fd.set("intensity", intensity);
    if (effectiveSessionDuration != null)
      fd.set("duration_min", String(effectiveSessionDuration));
    // Estimated calories (issue #151): submit whatever's in the field (auto or
    // overridden). A blank field is omitted, which clears any stored estimate.
    if (estCalories.trim()) fd.set("est_calories", estCalories.trim());
    // Session-level equipment (issue #342): sent only for a non-strength session
    // where a piece of gear is linked. Omitting it clears the link server-side (the
    // UPDATE always writes the column) — so switching a session to None, or to pure
    // strength, drops the stored gear rather than stranding it.
    if (sessionEquipmentType != null && activityEquipmentId != null)
      fd.set("equipment_id", String(activityEquipmentId));
    return fd;
  }

  // --- Auto-save: debounced persist that keeps the form open. ---
  const formSig = useMemo(
    () =>
      JSON.stringify({
        date,
        startTime,
        endTime,
        intensity,
        notes,
        parts,
        title: effectiveTitle,
        estCalories,
        sessionDuration,
        activityEquipmentId,
      }),
    [
      date,
      startTime,
      endTime,
      intensity,
      notes,
      parts,
      effectiveTitle,
      estCalories,
      sessionDuration,
      activityEquipmentId,
    ]
  );
  // The auto-save state machine (#1189, extracted per #1207): debounced persist,
  // created-row reuse, in-flight serialization, unmount + close-path flush. The
  // parent stays the single owner of form state; the hook drives persistence over
  // `buildFormData` and reports status/dirtiness back.
  const autosave = useActivityAutosave({
    formSig,
    canSave,
    editId: editData?.id ?? null,
    isPrefillCreate: !!prefill && !editData,
    buildFormData,
    toast,
  });
  const { status, savedAt, createdId, savableId, hasRow, dirty } = autosave;

  // The live-mode recap (#924): computed from the SAME form parts the user just
  // logged, through the ONE pure sessionRecap (over the shipped ExerciseHistoryMap),
  // so the finish step, the finished-window dashboard card, and the Telegram recap
  // line can't disagree (#221). Duration previews start→now when the session hasn't
  // been stamped ended yet — viewing the recap doesn't itself write an end time.
  const stepRecap = useMemo<Recap>(() => {
    // buildActivityPayload requires a savable form (non-empty named parts with
    // resolved types) — it dereferences comps[0] — so gate on canSave. The recap
    // step is only ever shown once a set is logged (canSave true); an empty draft
    // yields an empty recap rather than throwing on every render.
    if (!canSave) {
      return {
        title: effectiveTitle,
        durationMin: null,
        intensity: intensity || null,
        exercises: [],
        totalWorkingSets: 0,
        totalVolumeKg: 0,
        targetRollup: "none-targeted",
        prExercises: [],
        avgRpe: null,
      };
    }
    const { flat } = buildActivityPayload(
      classifier,
      namedParts,
      overallDuration
    );
    const previewEnd = endTime || (startTime ? nowHHMM(tz) : "");
    const previewDur =
      startTime && previewEnd ? minutesBetween(startTime, previewEnd) : null;
    const durationMin =
      overallDuration != null
        ? Math.round(overallDuration)
        : previewDur != null && previewDur > 0
          ? Math.round(previewDur)
          : null;
    const session = recapSessionFromPayload(
      flat,
      {
        title: effectiveTitle,
        durationMin,
        intensity: intensity || null,
        bodyweightKg: bodyweightKg ?? 0,
      },
      units.weightUnit
    );
    return sessionRecap(session, history, {
      currentActivityId: editData?.id ?? createdId,
    });
  }, [
    classifier,
    namedParts,
    overallDuration,
    startTime,
    endTime,
    tz,
    effectiveTitle,
    intensity,
    bodyweightKg,
    units.weightUnit,
    history,
    editData?.id,
    createdId,
    canSave,
  ]);

  // Save from the recap step: stamp the end time and leave live mode, collapsing to
  // the plain editor for the now-finished session (the #340 finishWorkout landing).
  // Auto-save persists the fields (end time + effort + notes); this is the explicit
  // finalize the step promises — viewing the recap alone writes nothing.
  function saveRecapStep() {
    finishWorkout();
  }

  // Plain-form "Finish workout" (#1124): the in-app finish for NON-live logging.
  // Stamp end = now and open the SAME SessionCompleteStep the live panel's Finish
  // reaches (#221, one step, two entrypoints), so a plain-form logger gets the
  // end-stamp + the session-effort capture without needing live/in-gym mode. Offered
  // only in create mode on TODAY (a retro/edit "end = now" is wrong — the DateTimeFields
  // "now" shortcut covers retro), once there's savable content and no end yet.
  const canFinishInForm =
    !isEdit &&
    !liveMode &&
    !showRecap &&
    !endTime &&
    date === todayStr(tz) &&
    canSave;
  function openFinishRecap() {
    if (!endTime) setEndTime(nowHHMM(tz));
    setShowRecap(true);
  }

  const moreDetailsSummary = activityDisclosureSummary({
    metrics: editData?.imported_metrics,
    distanceUnit: units.distanceUnit,
    calorieKcal:
      editData?.calorie_kcal ??
      (Number.isFinite(displayedCalories) && displayedCalories > 0
        ? displayedCalories
        : null),
    calorieEstimated:
      editData?.calorie_kcal != null
        ? !!editData.calorie_estimated
        : displayedCalories > 0,
  });
  // Only MANUAL activities get an estimate field — an imported row carries device
  // energy. Shown once there's an estimate to fill (or the user has typed one).
  const showEstimate =
    !editData?.source &&
    (autoEstimateKcal != null || estCalories.trim() !== "");

  // Closing goes through requestClose (defined below the save machinery), which
  // warns when a blocked form would drop edits; the ref keeps this effect
  // subscribed once.
  const requestCloseRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close the topmost layer: with the plate builder open, Escape dismisses
      // just the builder, not the whole editor.
      if (plateTarget) setPlateTarget(null);
      else requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plateTarget, setPlateTarget]);

  async function remove() {
    const id = savableId();
    if (id == null) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: "Delete activity",
      message: `Delete “${editData?.title ?? liveTitle}” (${date})? You can undo this.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("id", String(id));
      // Multi-view (#1330): delete the subject's activity on ITS profile (gateItemProfile
      // → requireProfileWriteAccess); absent single-view falls back to the acting profile.
      if (editData?.subjectProfileId != null)
        fd.set("profile_id", String(editData.subjectProfileId));
      // Don't let the unmount flush re-create the row we just deleted.
      autosave.markDeleted();
      // Capture-and-delete with an Undo toast (issue #30). undoable() runs the
      // action and surfaces the toast; closing the modal + refresh reflect it.
      await undoable(deleteActivity, fd, {
        deletedMessage: "Activity deleted.",
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function saveBodyweight() {
    const w = Number(bwInput);
    if (!Number.isFinite(w) || w <= 0) return;
    setBwSaving(true);
    try {
      await logBodyweight(w, date, units.weightUnit);
      setBwKnown(true);
      router.refresh();
    } finally {
      setBwSaving(false);
    }
  }
  // Index of the first bodyweight part, so the bodyweight prompt shows once.
  const firstBwPart = parts.findIndex((p) => isBodyweight(p.name));

  // Base names of the lifts already committed in this draft — the co-occurrence
  // signal that biases each part's combobox toward companions (issue #195).
  const enteredLiftBases = parts
    .filter((p) => partType(p) === "strength" && p.name.trim())
    .map((p) => baseLiftName(p.name).trim().toLowerCase());

  // Nag when the user has changed something the save can't accept, but also on
  // an untouched existing activity whose loaded data already can't save (e.g.
  // imported rows or records predating stricter validation) — otherwise edits
  // would silently never persist. Only a pristine blank create shows nothing.
  const blocker =
    (dirty || hasRow) && !canSave
      ? durationError
        ? "Total duration must cover the timed activity components."
        : analysis.saveBlocker
      : null;

  // Auto-save can't persist a blocked form, so closing one with unsaved edits
  // to a real row would silently drop them — confirm first. A blocked blank
  // create is exempt: discarding it is the natural "cancel". The durable
  // before-close flush lives in the auto-save hook (#1189).
  async function requestClose() {
    if (hasRow && dirty && !canSave) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        message:
          "Some changes can’t be saved yet and will be lost. Close anyway?",
        confirmLabel: "Close anyway",
        danger: true,
      });
      if (!ok) return;
    }
    await autosave.flushBeforeClose();
    onClose();
  }
  requestCloseRef.current = requestClose;

  return (
    <form
      data-testid="activity-form"
      // The form never submits on Enter — the debounced auto-save handles
      // persistence, so a stray Enter (e.g. right after picking from the
      // combobox) does nothing rather than forcing a premature save.
      // preventDefault also stops a full-page reload.
      onSubmit={(e) => e.preventDefault()}
      className="space-y-5"
    >
      {showRecap ? (
        <SessionCompleteStep
          recap={stepRecap}
          unit={units.weightUnit}
          intensity={intensity}
          onIntensity={setIntensity}
          notes={notes}
          onNotes={setNotes}
          onBack={() => setShowRecap(false)}
          onSave={saveRecapStep}
        />
      ) : (
        <>
          <ActivityFormHeader
            headingType={headingType}
            headingTitle={firstValid?.name}
            effectiveTitle={effectiveTitle}
            title={title}
            date={date}
            editData={editData}
            pending={status === "saving"}
            savedAt={savedAt}
            saveError={status === "error"}
            blocker={blocker}
            overlay={stickyFooter}
            onTitleChange={(value) => {
              setTitle(value);
              setTitleEdited(true);
            }}
            onClose={requestClose}
          />

          {/* Live workout mode (issue #340): the in-gym control strip pinned above
          the normal form — rest timer + Finish. The form below is unchanged, so
          Finish just collapses this back to the plain editor. */}
          {liveMode && (
            <LiveWorkoutPanel
              leadExercise={liveLeadExercise}
              restStartKey={restStartKey}
              onFinish={() => setShowRecap(true)}
            />
          )}

          {/* Activities — one or more parts, each chosen from the dropdown */}
          <ActivityPartsList
            parts={parts}
            stickyFooter={stickyFooter}
            isEdit={isEdit}
            units={units}
            history={history}
            deloadContext={deloadContext}
            recoveringContext={recoveringContext}
            plateauHints={plateauHints}
            currentActivityId={editData?.id ?? createdId}
            editedDate={editData?.date ?? null}
            equipmentList={equipmentList}
            overallDuration={overallDuration}
            bwKnown={bwKnown}
            firstBwPart={firstBwPart}
            bwInput={bwInput}
            bwSaving={bwSaving}
            onBwInput={setBwInput}
            onSaveBodyweight={saveBodyweight}
            equipmentRankedOptions={equipmentRankedOptions}
            enteredLiftBases={enteredLiftBases}
            liftCompanions={suggestions.liftCompanions}
            isKnown={isKnown}
            partType={partType}
            partNeedsDistance={partNeedsDistance}
            partIssue={partIssue}
            blocked={!!blocker}
            canAddPart={canAddPart}
            showRollup={showRollup}
            rollupDistanceKm={rollup.distanceKm}
            rollupDurationMin={rollup.durationMin}
            onTypePartName={typePartName}
            onPickPartName={pickPartName}
            onMovePart={movePart}
            onRemovePart={removePart}
            onAddPart={addPart}
            onUpdatePart={updatePart}
            onUpdateSet={updateSet}
            onAddSet={addSet}
            onRemoveSet={removeSet}
            onUpdatePartName={updatePartName}
            onApplySuggestion={applySuggestion}
            onApplyPerSideSuggestion={applyPerSideSuggestion}
            onFillFromSession={fillFromSession}
            onPlateFromSuggestion={plateFromSuggestion}
            onPlateTarget={setPlateTarget}
          />

          {/* Plain-form "Finish workout" (#1124): the in-app finish for non-live
          create logging — stamps end = now and opens the shared SessionCompleteStep
          (session-effort capture). Live mode has its own Finish in the panel above. */}
          {canFinishInForm && (
            <button
              type="button"
              onClick={openFinishRecap}
              data-testid="plain-finish-workout"
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 active:scale-95"
            >
              <IconFlagCheck className="h-4 w-4" />
              Finish workout
            </button>
          )}

          <section
            data-testid="session-details"
            aria-labelledby="session-details-title"
            className="py-1"
          >
            <h3 id="session-details-title" className="sr-only">
              Session details
            </h3>
            <DateTimeFields
              date={date}
              startTime={startTime}
              endTime={endTime}
              tz={tz}
              timeError={timeError}
              dateError={dateError}
              showSessionDuration={hasStrengthPart}
              sessionDuration={
                overallDuration != null
                  ? String(Math.round(overallDuration))
                  : sessionDuration
              }
              durationDerived={overallDuration != null}
              durationError={durationError}
              derivableDurationMin={derivableDurationMin}
              onDate={setDate}
              onStartTime={setStartTime}
              onEndTime={setEndTime}
              onSessionDuration={setSessionDuration}
            />
            {showTimeBreakdown && (
              <p
                data-testid="activity-time-breakdown"
                className="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                Active {sessionTiming.activeMin} min · Elapsed{" "}
                {sessionTiming.elapsedMin} min ({sessionTiming.restMin} min
                rest)
              </p>
            )}
            <div
              className={`mt-3 grid gap-x-4 gap-y-2 ${sessionEquipmentType != null ? "sm:grid-cols-2" : ""}`}
            >
              <IntensityPicker
                intensity={intensity}
                compact
                onChange={setIntensity}
              />

              {/* Session-level equipment (issue #342): the gear the whole non-strength
              activity used — a ride's bike, a run's shoes. */}
              {sessionEquipmentType != null && (
                <ActivityEquipmentPicker
                  activityType={sessionEquipmentType}
                  activityName={sessionEquipmentName}
                  equipment={equipmentList}
                  value={activityEquipmentId}
                  compact
                  onChange={(id) => {
                    equipmentTouchedRef.current = true;
                    setActivityEquipmentId(id);
                  }}
                />
              )}
            </div>
          </section>

          <ActivityMoreDetails
            open={moreDetailsOpen}
            onToggle={() => setMoreDetailsOpen((open) => !open)}
            summary={moreDetailsSummary}
            notes={notes}
            onNotesChange={setNotes}
            showEstimate={showEstimate}
            displayedEstCalories={displayedEstCalories}
            estEdited={estEdited}
            autoEstimateKcal={autoEstimateKcal}
            onEstChange={(v) => {
              setEstCalories(v);
              setEstEdited(true);
            }}
            onEstReset={() => {
              setEstEdited(false);
              setEstCalories(String(autoEstimateKcal));
            }}
            editData={editData}
            distanceUnit={units.distanceUnit}
          />

          {/* Auto-save is paused: spell out what to fix (the offending fields are
          also highlighted above). There's no Save button to lean on — the form
          always auto-saves. */}
          {blocker && (
            <p
              className="-mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
              role="status"
            >
              <IconAlertTriangle className="h-4 w-4 shrink-0" />
              <span>Not saved — {blocker}</span>
            </p>
          )}

          <ActivityFormFooter
            stickyFooter={stickyFooter}
            hasRow={hasRow}
            saving={saving}
            pending={status === "saving"}
            error={status === "error"}
            savedAt={savedAt}
            onDelete={remove}
            onDone={requestClose}
          />
        </>
      )}

      {plateTarget && (
        <PlateBuilderModal
          unit={units.weightUnit}
          equipment={equipmentList}
          initialBarId={parts[plateTarget.pi]?.equipmentId ?? null}
          initialWeight={
            plateTarget.seed ??
            (Number(
              parts[plateTarget.pi]?.sets[plateTarget.si]?.[plateTarget.field]
            ) ||
              0)
          }
          onUse={applyPlateBuild}
          onCreated={(e) => setEquipmentList((prev) => [...prev, e])}
          onClose={() => setPlateTarget(null)}
        />
      )}
    </form>
  );
}
