"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteActivity,
  logBodyweight,
} from "@/app/(app)/training/activity-actions";
import type { ActivityType, Equipment } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { isBodyweight, baseLiftName } from "@/lib/lifts";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { RpeTracking } from "@/lib/rpe";
import {
  compositeRollup,
  inferFreeTextType,
  minutesBetween,
  titleCase,
} from "@/lib/activity-meta";
import { activityTiming } from "@/lib/activity-timing";
import {
  summarizeEquipmentAvailability,
  deRankUnavailableLifts,
} from "@/lib/equipment-availability";
import { IconAlertTriangle } from "@tabler/icons-react";
import PlateBuilderModal from "./PlateBuilderModal";
import { isRealIsoDate } from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { OFFLINE_CAPTURE_REFUSED_MESSAGE } from "@/lib/offline/queue";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useLatestRef } from "@/components/useLatestRef";
import { useHaptics } from "@/components/useHaptics";
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
import { Notice } from "./Notice";
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
import ActivitySessionFactRow from "./activity-form/ActivitySessionFactRow";
import FactEditorHost, { useFactEditor } from "./facts/FactEditorHost";
import DraftRestoreBanner from "./DraftRestoreBanner";
import { useFormDraft } from "./useFormDraft";
import {
  requestUpdateReload,
  useManualUpdateFallback,
} from "./update-reload-channel";
import type { PartEntry } from "@/lib/activity-form-model";
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
import {
  ACTIVITY_SESSION_FACT_NOUNS,
  activitySessionFactSummary,
  type ActivitySessionFactKey,
} from "@/lib/activity-session-facts";
import { estimateActivityKcal } from "@/lib/calorie-estimate";
import { activityDisclosureSummary } from "@/lib/activity-import-details";
import { activityEditDataHasStrength } from "@/lib/activity-form-model";
import { activityIconIdentitiesAreComposite } from "@/lib/activity-icon";

// Re-exported so existing callers keep importing the edit-payload shape from
// this module; the definition now lives in ./activity-form/model.
export type { ActivityEditData };

// The shared activity create/edit form, rendered inside ActivityOverlay or docked
// in the training log's right column. Either way it auto-saves: changes persist a
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
  strengthTrainingAvailable,
  editData,
  prefill = null,
  initialDate,
  live = false,
  onLiveFinished,
  adoptRowId = null,
  adoptPending = false,
  onRowOwned,
  deloadContext,
  recoveringContext = { temperedRegions: [], constraints: [] },
  plateauHints = [],
  rpeTracking = null,
  onClose,
  onCloseRequestReady,
  onDeleted,
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
  // New strength content starts in adolescence. Existing strength records stay
  // editable, so their vocabulary is retained when editData already carries it.
  strengthTrainingAvailable: boolean;
  editData: ActivityEditData | null;
  // "Log again" / "Repeat last" seed (issue #29): pre-fills the form's initial
  // state (title, exercises, sets) exactly like editData, but the form still
  // treats it as a CREATE — saves insert a new activity, and the prefilled
  // content auto-saves on open. Ignored when editData is present.
  prefill?: ActivityEditData | null;
  // Date-only create seed from a day-history link. Kept separate from a repeat
  // prefill so choosing a day never fabricates an activity type or title.
  initialDate?: string;
  // Live workout mode (issue #340): opens the form in the in-gym layout — a
  // control strip with the rest timer + Finish above the normal form. Purely a
  // presentation flag over the same form state (no second engine); "Finish"
  // collapses it back to the plain editor. Since #2870 step 3 it also applies
  // to a resumed session's edit, not just creates.
  live?: boolean;
  // The overlay drops its live-only minimize chrome once Finish settles this
  // form back into an ordinary activity editor.
  onLiveFinished?: () => void;
  // The provider-created session row for a create-at-start live workout (#2870
  // step 3): adopted by the autosave without a re-key, so saves UPDATE it.
  adoptRowId?: number | null;
  // The create-at-start POST has not answered yet (#3441). Forwarded to the
  // autosave, which defers a rowless mid-session save while it is true so one live
  // session can never become two rows.
  adoptPending?: boolean;
  // Fired once when a rowless form first owns a row (adoption or its own first
  // create) — the provider's one-URL navigation trigger (#2870 step 3).
  onRowOwned?: (id: number) => void;
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
  // The profile's opted-into RPE scale, or null (#3335). Null is not "off by
  // default" — it is the absence of anything to render, which is why no strength
  // surface can put an effort column on screen for a profile that never asked.
  rpeTracking?: RpeTracking | null;
  onClose: () => void;
  // The containing dialog routes Escape through the same save-aware path as
  // Done, the backdrop, and the live-workout minimize control.
  onCloseRequestReady?: (
    requestClose: ((beforeClose?: () => void) => Promise<boolean>) | null
  ) => void;
  // The provider owns route context. Report a completed delete so it can leave a
  // canonical detail URL that now points at no record.
  onDeleted?: (id: number) => void;
  // In the overlay the (often taller-than-viewport) form scrolls, so the action
  // row pins to the bottom of the screen and gains a Done button — otherwise
  // closing means scrolling back up to the ✕. The docked editor keeps the plain
  // row: sticking to the page viewport there would detach it from the form.
  stickyFooter?: boolean;
}) {
  const tz = useTimezone();
  // Kept for the unmount-flush failure path: the toast outlives the form.
  const toast = useToast();
  // Offline capture for a never-created session (#1596) — see onQueueOffline below.
  const { enqueue: enqueueOffline } = useOfflineQueue();
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  // Which surface this editor was opened from (#3087).
  const stampLoggedVia = useLoggedViaStamp();
  const [saving, setSaving] = useState(false);
  // The row the form's initial state is reconstructed from: a stored row being
  // edited, or a "Log again"/"Repeat last" prefill. In prefill mode this only
  // seeds state — editData stays null, so isEdit/savableId/hasRow all keep their
  // create semantics and the first save inserts a new activity.
  const seed = editData ?? prefill;
  const allowStrengthParts =
    strengthTrainingAvailable ||
    (editData != null && activityEditDataHasStrength(editData));

  // Bodyweight lifts fold the user's bodyweight into their volume/strength stats.
  // If none is on record, prompt for it inline (saved as a body-metrics entry).
  const [bwKnown, setBwKnown] = useState(bodyweightKg != null);
  const [bwInput, setBwInput] = useState("");
  const [bwSaving, setBwSaving] = useState(false);

  const { allOptions, typeByName } = useMemo(() => {
    const m = new Map<string, ActivityType>();
    for (const n of suggestions.sports) m.set(n.toLowerCase(), "sport");
    for (const n of suggestions.cardio) m.set(n.toLowerCase(), "cardio");
    if (allowStrengthParts)
      for (const n of suggestions.lifts) m.set(n.toLowerCase(), "strength");
    const all = [
      ...new Set([
        ...(allowStrengthParts ? suggestions.lifts : []),
        ...suggestions.cardio,
        ...suggestions.sports,
      ]),
    ];
    return { allOptions: all, typeByName: m };
  }, [suggestions, allowStrengthParts]);

  // The evidence the picker's matcher is allowed to weigh (#2384). Built once here
  // beside allOptions and handed down as data; lib/fuzzy owns what it is worth.
  const usedActivityNames = useMemo(
    () => new Set(suggestions.logged),
    [suggestions]
  );

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
  // The same treatment for the RPE opt-in (#3335), so the column appears on the tap
  // that asked for it rather than on the next server round-trip — the editor may be
  // mid-session and must not lose its unsaved state to a refetch.
  //
  // The state holds what the ACTION answered with, never a locally minted scale:
  // lib/rpe-tracking.ts stays the one producer even though the tap is optimistic.
  const [rpeScale, setRpeScale] = useState<RpeTracking | null>(rpeTracking);
  // ONE editor-local append for every in-form equipment creation path — the plate
  // builder's bar (#335) and the strength picker's quick-add (#1611) — so a row
  // created mid-workout is immediately pickable on every part without a reload and
  // without discarding the activity being edited.
  const addEquipment = (e: Equipment) =>
    setEquipmentList((prev) =>
      prev.some((x) => x.id === e.id) ? prev : [...prev, e]
    );

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
  // auto-defaults to the last-used gear for that type, mirroring the strength
  // picker's recency. `undefined` means the create draft has not chosen yet;
  // `null` is the user's explicit "None", which the default must never override.
  const [activityEquipmentId, setActivityEquipmentId] = useState<
    number | null | undefined
  >(
    editData
      ? (editData.equipment_id ?? null)
      : (seed?.equipment_id ?? undefined)
  );
  // The SESSION-LEVEL FACT CHIPS (#3334) and their one-editor-at-a-time contract, from
  // the shared facts-with-editors primitive (#3218). This form supplies only its own
  // fact keys; the chip row, the Done/Esc gesture and the focus return are the
  // primitive's.
  //
  // THIS FORM IS SAFE TO UNMOUNT A CLOSED EDITOR, and that is a fact about THIS form
  // rather than about the pattern — read it before adding a second fact here. #3228
  // warns that the activity editor is a DOM-collected `<form action={handle}>`, where a
  // field the browser cannot see is a field the save CLEARS (#2359). It is not: the
  // <form> below only `preventDefault`s, and `buildFormData` composes every field by
  // hand out of React state, exactly as the sleep dialog does. So the equipment link
  // posts from `activityEquipmentId` whether or not its picker is mounted, and the
  // "unsaved changes" prompt reads `dirty` off `formSig` — also state — rather than off
  // the DOM-scanning dirty registry, which tracks NAMED controls only and finds not one
  // in this tree. That `dirty` is published as `data-unsaved` on the <form> below, so a
  // test can read it while the form is open (#3351). Both halves are pinned in
  // e2e/activity-equipment.spec.ts, because a future field bound straight to the DOM
  // would break them silently.
  const factScopeRef = useRef<HTMLElement>(null);
  const {
    openEditor: openFact,
    open: openFactEditor,
    close: closeFactEditor,
    onKeyDown: onFactKeyDown,
  } = useFactEditor<ActivitySessionFactKey>({ scopeRef: factScopeRef });

  // Lazy initializers: the fallbacks format dates, no need to redo that work on
  // every render just to discard it.
  const [date, setDate] = useState(
    () => seed?.date ?? initialDate ?? todayStr(tz)
  );
  const [startTime, setStartTime] = useState(() =>
    editData ? (editData.start_time ?? "") : nowHHMM(tz)
  );
  const [endTime, setEndTime] = useState(editData?.end_time ?? "");
  const finishStampedEndRef = useRef(false);
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
  const revealMoreDetails = useCallback(
    () => setMoreDetailsOpen(true),
    [setMoreDetailsOpen]
  );

  const isEdit = !!editData;
  // Live workout mode (issue #340). No longer create-only (#2870 step 3):
  // create-at-start hands the live session its row as editData, so live now
  // rides the edit path (savableId targets the row from the first save). Held
  // as state so "Finish workout" can collapse it back to the plain form.
  // `restStartKey` bumps on every set check-off to auto-start the rest timer.
  const [liveMode, setLiveMode] = useState(live);
  // The editor's root element, marked `data-draft-backed` by the draft hook (#2471).
  const formElRef = useRef<HTMLFormElement>(null);
  // Whether the automatic update reload has given up on this episode (#2471). The
  // stale-save banner is that fallback, not the first answer any more.
  const manualFallback = useManualUpdateFallback();
  const [restStartKey, setRestStartKey] = useState(0);
  // The shared haptic adapter (#1422) — the `commit` tick below goes through it.
  const haptic = useHaptics();
  // The live-mode "Session complete" step (#924): Finish opens the recap step
  // instead of collapsing straight to the plain form. It's the ONLY live-gated
  // renderer — reachable only from the live panel's Finish, so retro/plain-form
  // logging and edits never see it.
  const [showRecap, setShowRecap] = useState(false);

  // The parts/sets state machine (#1207 extraction): the `parts` list + plate-builder
  // target and every mutation over them (name/variant resolution, set + part CRUD,
  // suggestion/repeat fills, the plate round-trip). The parent stays composition over
  // this hook plus the auto-save hook and the presentational sections.
  const defaultCustomType =
    prefill?.title === "" &&
    !prefill.components &&
    (prefill.type === "cardio" || prefill.type === "sport")
      ? prefill.type
      : null;
  const activityParts = useActivityParts({
    seed,
    units,
    history,
    isEdit,
    equipmentList,
    isKnown,
    customFlags,
    // A protocol's type-scoped action opens a deliberately blank create seed.
    // Keep that type as the fallback when the user commits an unknown custom
    // activity name; recognizable names still use their inferred catalog type.
    defaultCustomType,
    // A set check-off starts the live-mode rest timer (#340) and fires a short haptic
    // tick (#1422) — the phone-in-pocket confirmation that the set registered, distinct
    // from the rest timer's end-of-rest double-pulse. Live mode only: the tick means
    // "your set landed, rest is running", which is exactly what plain-form retro logging
    // isn't doing.
    onSetCheckedOff: () => {
      if (!liveMode) return;
      setRestStartKey((n) => n + 1);
      haptic("commit");
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

  type HeadingIdentity = { type: ActivityType; title: string };
  const identityForPart = (part: PartEntry | undefined) => {
    if (!part) return null;
    const type = partType(part);
    return type ? { type, title: part.name } : null;
  };
  // Combobox text is a draft until the user commits it. Keep one committed
  // identity per part so renaming never clears the icon, while a mixed session
  // can still switch to the honest composite mark as components are committed.
  const [headingPartIdentities, setHeadingPartIdentities] = useState<
    (HeadingIdentity | null)[]
  >(() => parts.map(identityForPart));
  const committedHeadingIdentities = headingPartIdentities.filter(
    (identity): identity is HeadingIdentity => identity != null
  );
  const headingIdentity = committedHeadingIdentities[0] ?? null;
  const headingComposite = activityIconIdentitiesAreComposite(
    committedHeadingIdentities
  );

  function setCommittedHeadingIdentity(
    index: number,
    identity: HeadingIdentity
  ) {
    setHeadingPartIdentities((current) => {
      const next = [...current];
      next[index] = identity;
      return next;
    });
  }

  function commitHeadingName(index: number, rawName: string) {
    const name = isKnown(rawName) ? rawName : titleCase(rawName.trim());
    const type =
      classifier.nameType(name) ?? inferFreeTextType(name) ?? defaultCustomType;
    if (type) setCommittedHeadingIdentity(index, { type, title: name });
  }

  function pickPartNameWithIdentity(index: number, name: string) {
    pickPartName(index, name);
    commitHeadingName(index, name);
  }

  function updatePartWithIdentity(index: number, patch: Partial<PartEntry>) {
    updatePart(index, patch);
    if (!patch.customType) return;
    const name = parts[index]?.name.trim();
    if (name)
      setCommittedHeadingIdentity(index, {
        type: patch.customType,
        title: name,
      });
  }

  function updatePartNameWithIdentity(
    index: number,
    name: string,
    extra?: Partial<PartEntry>
  ) {
    updatePartName(index, name, extra);
    commitHeadingName(index, name);
  }

  function movePartWithIdentity(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination >= 0 && destination < parts.length) {
      setHeadingPartIdentities((current) => {
        const reordered = [...current];
        [reordered[index], reordered[destination]] = [
          reordered[destination],
          reordered[index],
        ];
        return reordered;
      });
    }
    movePart(index, direction);
  }

  function removePartWithIdentity(index: number) {
    setHeadingPartIdentities((current) =>
      current.filter((_, partIndex) => partIndex !== index)
    );
    removePart(index);
  }

  function addPartWithIdentity() {
    setHeadingPartIdentities((current) => [...current, null]);
    addPart();
  }

  const liveLeadExercise = leadExerciseName(parts.map((p) => p.name));
  function finishWorkout() {
    if (!endTime) changeEndTime(nowHHMM(tz));
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
  // "Fresh entry" includes a live session on its created-at-start row (#2870
  // step 3): the row is minutes old and empty, so create-time defaulting is
  // right for it; a resumed session with stored choices keeps them (state
  // seeds from editData, and estEdited pins a stored estimate).
  const defaultActivityEquipmentId =
    (!editData || liveMode) && sessionEquipmentType != null
      ? pickDefaultActivityEquipment(
          equipmentForActivity(
            equipmentList,
            sessionEquipmentType,
            sessionEquipmentName
          ),
          recentActivityEquipment
        )
      : null;
  // State records a seed or an explicit choice. Until the user chooses, the current
  // activity's recency default is derived directly, so changing Run → Ride cannot
  // leave the previous activity's gear stranded in the draft.
  const effectiveActivityEquipmentId =
    activityEquipmentId === undefined
      ? defaultActivityEquipmentId
      : activityEquipmentId;

  // What the equipment chip states (#3334).
  //
  // A LINK THIS EDITOR CANNOT NAME IS STILL A LINK. `equipmentList` is the whole list
  // the form was given, so a miss means a row it never received; stating "no equipment"
  // there would invite a tap that clears a fact nobody meant to clear. It states the
  // noun instead, and the picker behind the chip keeps that row selectable exactly as it
  // does today (ActivityEquipmentPicker's selectedMissing).
  const sessionGearName =
    effectiveActivityEquipmentId == null
      ? null
      : (equipmentList.find((e) => e.id === effectiveActivityEquipmentId)
          ?.name ?? ACTIVITY_SESSION_FACT_NOUNS.equipment);
  const sessionFacts = activitySessionFactSummary({
    gearName: sessionGearName,
    // `undefined` is precisely "the person has not chosen": the value on screen is the
    // recency default computed for them, which is a suggestion and not an assertion
    // (#846). An explicit None is `null` and is theirs.
    gearSuggested: activityEquipmentId === undefined,
  });
  // The equipment fact can leave the row entirely — switch the session to pure strength
  // and gear becomes per-set again. Close its editor with it, or the panel silently
  // reopens the next time a cardio part comes back. Focus has nowhere to return to here
  // (chip and row are both gone), and the primitive's three tiers all miss, which is the
  // right answer: it stays where the person's own edit put it.
  useEffect(() => {
    if (sessionEquipmentType == null && openFact != null) closeFactEditor();
  }, [sessionEquipmentType, openFact, closeFactEditor]);

  const liveTitle = generateActivityTitle(startTime, namedParts, classifier);
  // Until the user edits the title, the input and saved value follow the generated
  // one directly. There is no second stored copy to synchronize after render.
  const displayedTitle = titleEdited
    ? title
    : liveTitle === "New activity"
      ? ""
      : liveTitle;
  const effectiveTitle = displayedTitle.trim() || liveTitle;
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
  // Preserve a complete clock-derived duration as the standalone fallback if one
  // clock field is later removed. The clock interaction that completes the pair is
  // the source of that update; an effect does not need to copy the derived value.
  function rememberClockDuration(nextStart: string, nextEnd: string) {
    const duration = minutesBetween(nextStart, nextEnd);
    if (duration != null) setSessionDuration(String(Math.round(duration)));
  }
  function changeStartTime(nextStart: string) {
    setStartTime(nextStart);
    rememberClockDuration(nextStart, endTime);
  }
  function changeEndTime(nextEnd: string) {
    setEndTime(nextEnd);
    rememberClockDuration(startTime, nextEnd);
  }
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
  // Auto-fill is create-only. Derive the value that is persisted until the user
  // edits it; existing rows keep their stored field untouched merely by opening.
  const persistedEstCalories =
    (!editData || liveMode) && !estEdited
      ? autoEstimateKcal != null
        ? String(autoEstimateKcal)
        : ""
      : estCalories;
  const displayedEstCalories =
    (!editData || liveMode) && !estEdited
      ? persistedEstCalories
      : !estEdited && !estCalories.trim() && autoEstimateKcal != null
        ? String(autoEstimateKcal)
        : estCalories;
  const displayedCalories = Number(displayedEstCalories);

  // Build the FormData saveActivity expects from the current state. Callers gate
  // on `canSave` first. `savedId` is the live row id (existing or auto-created),
  // supplied by the auto-save machine so saves update in place rather than
  // inserting duplicates.
  function buildFormData(savedId: number | null): FormData {
    // The surface the session was entered on (#3087). The editor overlay opens from
    // the Training page, from the dashboard and from the quick-log sheet, so the
    // mounting answers and this form does not assume.
    const { comps, flat, primaryType } = buildActivityPayload(
      classifier,
      namedParts,
      overallDuration
    );

    const fd = stampLoggedVia(new FormData());
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
    if (persistedEstCalories.trim())
      fd.set("est_calories", persistedEstCalories.trim());
    // Session-level equipment (issue #342): sent only for a non-strength session
    // where a piece of gear is linked. Omitting it clears the link server-side (the
    // UPDATE always writes the column) — so switching a session to None, or to pure
    // strength, drops the stored gear rather than stranding it.
    if (sessionEquipmentType != null && effectiveActivityEquipmentId != null)
      fd.set("equipment_id", String(effectiveActivityEquipmentId));
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
        estCalories: persistedEstCalories,
        sessionDuration,
        activityEquipmentId: effectiveActivityEquipmentId,
      }),
    [
      date,
      startTime,
      endTime,
      intensity,
      notes,
      parts,
      effectiveTitle,
      persistedEstCalories,
      sessionDuration,
      effectiveActivityEquipmentId,
    ]
  );
  // The offline-capture callback below runs on the CLOSE-path flush, after `draft`
  // (declared later — it needs autosave's createdId) exists; the ref bridges the
  // declaration order without reordering the two hooks.
  // The auto-save state machine (#1189, extracted per #1207): debounced persist,
  // created-row reuse, in-flight serialization, unmount + close-path flush. The
  // parent stays the single owner of form state; the hook drives persistence over
  // `buildFormData` and reports status/dirtiness back.
  const autosave = useActivityAutosave({
    formSig,
    canSave,
    editId: editData?.id ?? null,
    adoptRowId,
    adoptPending,
    onRowOwned,
    isPrefillCreate: !!prefill && !editData,
    buildFormData,
    toast,
    // Offline capture (#1596): when the CLOSE-path flush dies on a dead connection
    // and this session never got a server row, the whole form — the exact fields
    // saveActivity would have received — is queued as a "set" intent and replayed
    // through the same write core on reconnect. `id`/`profile_id` are stripped so
    // the capture is create-only on the queue-stamped profile (#599). The local
    // draft (#1699) is discarded in the same breath: the queue is now the durable
    // owner, and a restorable draft would re-log the session a second time.
    onQueueOffline: async (fd) => {
      const fields: Record<string, string> = {};
      fd.forEach((value, key) => {
        if (typeof value === "string" && key !== "id" && key !== "profile_id")
          fields[key] = value;
      });
      const capturedDate = isRealIsoDate(fields.date ?? "")
        ? fields.date
        : todayStr(tz);
      const kept =
        (await enqueueOffline("set", capturedDate, { fields })) === "kept";
      // The device refused the capture (#3038): the queue owns nothing, so say
      // so in the shared sentence, KEEP the draft (whatever it still holds is
      // strictly better than nothing), and report false — the autosave hook then
      // treats the close as the failed save it is instead of a clean one. Keyed,
      // because the close-path flush retries a handful of times before giving up
      // and each attempt is the SAME refusal: one toast, replaced in place.
      if (!kept) {
        toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, {
          tone: "error",
          key: "offline-capture-refused",
        });
        return false;
      }
      // clear(), not discard(): it also cancels a pending draft write, so the
      // just-queued session can't be re-offered as a restorable draft.
      draftRef.current?.clear();
      toast("Workout saved offline — will sync when you reconnect.");
      return true;
    },
  });
  const {
    status,
    savedAt,
    staleBuild,
    retryingSave,
    createdId,
    savableId,
    hasRow,
    dirty,
  } = autosave;

  // --- Local draft: the net under everything the server auto-save can't hold. ---
  //
  // The auto-save above is the DURABLE copy, and it is the reason this form does not
  // simply persist everything locally: once a form is savable it creates a real row
  // and updates it. But two windows are still React-state-only, and #1699 is both of
  // them: (a) before the form is savable at all (a titled workout with a half-typed
  // first exercise saves nothing), and (b) between an edit and the debounce/round-trip
  // that persists it — which is exactly the window a deploy, a crash or a tab
  // eviction lands in. The draft covers those and nothing else: it is written on
  // change, and dropped the moment the server copy is provably current.
  //
  // A LIVE session is server-persisted (#451: the dock rehydrates it from
  // getActivityEditData after a reload), and this hook used to be INERT there on
  // that basis. But "server-backed" is only as true as the auto-save's POSTs: a
  // deploy under the open tab invalidates every Server Action id this build holds
  // (deployment skew's Server Action half — see docs/internals/deploy-skew.md),
  // so mid-set edits fail until the tab reloads. That is window (b) held open
  // indefinitely, with no local copy at all — the reported loss was a live workout
  // edited straight through a deploy. The draft therefore runs in live mode too;
  // the clear-on-success effect below keeps #451's concern answered: while saves
  // land, the draft is dropped the moment the server copy is current, so it only
  // ever outlives a save that failed.
  const draftExtra = useMemo(
    () => ({
      date,
      startTime,
      endTime,
      sessionDuration,
      intensity,
      notes,
      estCalories: persistedEstCalories,
      estEdited,
      title,
      titleEdited,
      activityEquipmentId: effectiveActivityEquipmentId,
      parts,
    }),
    [
      date,
      startTime,
      endTime,
      sessionDuration,
      intensity,
      notes,
      persistedEstCalories,
      estEdited,
      title,
      titleEdited,
      effectiveActivityEquipmentId,
      parts,
    ]
  );
  type ActivityDraft = typeof draftExtra;
  const draft = useFormDraft<ActivityDraft>({
    formKey: "activity",
    // This editor keeps everything in `extra`, so its <form> is not the captured
    // element — but its input is durable all the same, and the #1878 registry has to
    // know that or an automatic update reload would refuse to cross the very editor
    // #2471 is about (#2471).
    scopeRef: formElRef,
    // Carried on the resume pointer so the tab reopens the mode it was in.
    live: liveMode,
    // Once auto-save has created the row, the draft belongs to THAT row — so a
    // later blank create form can't restore it into a duplicate activity, and
    // reopening the row still offers the edits that never reached the server.
    recordId: editData?.id ?? createdId,
    extra: draftExtra,
    // THIS FORM PUBLISHES ITS OWN `data-unsaved` (see the <form> below), so the hook
    // must not (#3371). Two reasons, and both matter: the hook would write the same
    // attribute on the same element React renders it onto, and its answer would be
    // the WRONG one here — "has the content moved off the mount snapshot" is not the
    // question for an autosaving form, where a saved change is clean.
    ownsUnsavedMarker: true,
    onRestore: (d) => {
      setDate(d.date);
      setStartTime(d.startTime);
      setEndTime(d.endTime);
      setSessionDuration(d.sessionDuration);
      setIntensity(d.intensity);
      setNotes(d.notes);
      setEstCalories(d.estCalories);
      setEstEdited(d.estEdited);
      setTitle(d.title);
      setTitleEdited(d.titleEdited);
      setActivityEquipmentId(d.activityEquipmentId);
      const restoredParts = d.parts as PartEntry[];
      setParts(restoredParts);
      setHeadingPartIdentities(restoredParts.map(identityForPart));
      if (d.notes || d.estCalories) setMoreDetailsOpen(true);
    },
    confirmReplace: () =>
      confirm({
        title: "Resume the unsaved workout?",
        message:
          "This replaces what you have typed here with the entry kept on this device.",
        confirmLabel: "Resume",
      }),
  });
  const draftRef = useLatestRef(draft);
  const clearDraft = draft.clear;
  // Clear on successful save. `savedAt > 0 && !dirty` is precisely "the server has
  // everything on screen" — the only honest moment to drop the local copy.
  useEffect(() => {
    if (savedAt > 0 && !dirty) clearDraft();
  }, [savedAt, dirty, clearDraft]);

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
  // This explicit flush persists the fields (end time + effort + notes) before
  // the step collapses.
  async function saveRecapStep() {
    // Finish is an explicit commit boundary. Persist the latest title, effort,
    // notes, and end stamp before collapsing the recap so a quick Save followed
    // by navigation cannot outrun the autosave debounce.
    await autosave.flushBeforeClose();
    finishWorkout();
    if (live) onLiveFinished?.();
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
    finishStampedEndRef.current = !endTime;
    if (finishStampedEndRef.current) changeEndTime(nowHHMM(tz));
    setShowRecap(true);
  }
  function backFromFinishRecap() {
    // Remove only the tentative stamp created by Finish. An explicit end time
    // entered before the recap belongs to the user and survives Back.
    if (finishStampedEndRef.current) changeEndTime("");
    finishStampedEndRef.current = false;
    setShowRecap(false);
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
      // …nor the draft offer it back on the next open.
      draft.discard();
      // Capture-and-delete with an Undo toast (issue #30). undoable() runs the
      // action and surfaces the toast; closing the modal + refresh reflect it.
      await undoable(deleteActivity, fd, {
        deletedMessage: "Activity deleted.",
      });
      onClose();
      onDeleted?.(id);
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
  const requestClose = useCallback(
    async (beforeClose?: () => void) => {
      if (hasRow && dirty && !canSave) {
        const ok = await confirm({
          title: "Discard unsaved changes?",
          message:
            "Some changes can’t be saved yet and will be lost. Close anyway?",
          confirmLabel: "Close anyway",
          danger: true,
        });
        if (!ok) return false;
      }
      await autosave.flushBeforeClose();
      beforeClose?.();
      onClose();
      return true;
    },
    [hasRow, dirty, canSave, confirm, autosave, onClose]
  );
  useEffect(() => {
    onCloseRequestReady?.(requestClose);
    return () => onCloseRequestReady?.(null);
  }, [onCloseRequestReady, requestClose]);
  return (
    <form
      ref={formElRef}
      data-testid="activity-form"
      // Whether this form is holding a change the server has not got yet — the
      // SAME `dirty` the "Discard unsaved changes?" prompt consults a few lines
      // up, published so it can be read from outside while the form is still
      // open (#3351).
      //
      // WHY THIS EXISTS AT ALL, since a reviewer's first instinct is that the
      // dirty-form registry already answers this. It does not, for this form.
      // The registry tracks NAMED controls (`isTrackable` returns false without
      // a `name`, DirtyFormRegistry.tsx) and this tree has none — every field is
      // composed by hand out of React state by `buildFormData`. So the registry's
      // answer for this form is a permanent "clean", and reaching for it here
      // would be adopting a SECOND answer to one question rather than publishing
      // the one the form already acts on.
      //
      // NOT NEW STATE, and it must not become any: `dirty` is autosave's
      // `formSig !== savedSig`, computed in one place and read here. If a change
      // ever needs this marker and the prompt to disagree, that is a bug in the
      // change, not a reason for a second signal.
      //
      // TO THE REVIEWER WHO WANTS TO DELETE THIS as untested instrumentation: it
      // is what lets a browser test observe a change being counted WITHOUT
      // waiting out SAVED_FADE_MS, which is a constant chosen for how a
      // confirmation feels. e2e/activity-equipment.spec.ts asserts on it; the
      // #3334 pin used to race that fade instead.
      data-unsaved={dirty ? "true" : "false"}
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
          onBack={backFromFinishRecap}
          onSave={saveRecapStep}
        />
      ) : (
        <>
          <ActivityFormHeader
            headingType={headingIdentity?.type ?? null}
            headingTitle={headingIdentity?.title}
            headingComposite={headingComposite}
            effectiveTitle={effectiveTitle}
            title={displayedTitle}
            date={date}
            editData={editData}
            pending={status === "saving"}
            savedAt={savedAt}
            saveError={status === "error"}
            blocker={blocker}
            overlay={stickyFooter}
            showMinimize={liveMode}
            onTitleChange={(value) => {
              setTitle(value);
              setTitleEdited(true);
            }}
            onClose={requestClose}
          />

          {/* An unsaved entry this device kept from an interrupted session
              (#1699). Never applied on its own — the user chooses. */}
          <DraftRestoreBanner draft={draft} noun="workout" />

          {/* Deployment skew: the deploy invalidated this build's action ids, so
              every save fails until the tab reloads. Unlike an ordinary failed
              save, retrying cannot help — say so, name the remedy, and make it
              one tap. "Kept on this device" is the draft's promise (#1699), which
              runs in live mode too for exactly this state.

              Since #2471 the tab normally fixes this itself, so this banner is the
              RATIONED-FAILURE fallback: it renders only once the registrar has said
              the automatic attempt is spent (or is refused because work on screen
              would not survive). Its Reload goes through the same shared path the
              automatic one does, so a manual tap flushes the draft and leaves the
              resume marker too. */}
          {staleBuild && manualFallback && (
            <Notice
              tone="rose"
              icon
              testid="stale-save-banner"
              title="The app has updated — changes here can’t be saved"
              action={
                <button
                  type="button"
                  onClick={() => void requestUpdateReload()}
                  className="font-medium underline-offset-2 hover:underline"
                  data-testid="stale-save-reload"
                >
                  Reload
                </button>
              }
            >
              Your entry is kept on this device. Reload to keep saving — you can
              restore it right after.
            </Notice>
          )}

          {/* Live workout mode (issue #340): the in-gym control strip pinned above
          the normal form — rest timer + Finish. The form below is unchanged, so
          Finish just collapses this back to the plain editor. */}
          {liveMode && (
            <LiveWorkoutPanel
              leadExercise={liveLeadExercise}
              restStartKey={restStartKey}
              onFinish={openFinishRecap}
            />
          )}

          {/* Activities — one or more parts, each chosen from the dropdown */}
          <ActivityPartsList
            parts={parts}
            stickyFooter={stickyFooter}
            isEdit={isEdit}
            live={liveMode}
            units={units}
            history={history}
            deloadContext={deloadContext}
            recoveringContext={recoveringContext}
            plateauHints={plateauHints}
            rpeTracking={rpeScale}
            onRpeTrackingChange={setRpeScale}
            currentActivityId={editData?.id ?? createdId}
            editedDate={editData?.date ?? null}
            equipmentList={equipmentList}
            onEquipmentCreated={addEquipment}
            overallDuration={overallDuration}
            bwKnown={bwKnown}
            firstBwPart={firstBwPart}
            bwInput={bwInput}
            bwSaving={bwSaving}
            onBwInput={setBwInput}
            onSaveBodyweight={saveBodyweight}
            equipmentRankedOptions={equipmentRankedOptions}
            usedActivityNames={usedActivityNames}
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
            onPickPartName={pickPartNameWithIdentity}
            onMovePart={movePartWithIdentity}
            onRemovePart={removePartWithIdentity}
            onAddPart={addPartWithIdentity}
            onUpdatePart={updatePartWithIdentity}
            onUpdateSet={updateSet}
            onAddSet={addSet}
            onRemoveSet={removeSet}
            onUpdatePartName={updatePartNameWithIdentity}
            onApplySuggestion={applySuggestion}
            onApplyPerSideSuggestion={applyPerSideSuggestion}
            onFillFromSession={fillFromSession}
            onPlateFromSuggestion={plateFromSuggestion}
            onPlateTarget={setPlateTarget}
          />

          <section
            ref={factScopeRef}
            data-testid="session-details"
            aria-labelledby="session-details-title"
            className="py-1"
            // The region the chips and the one editor share (#3218/#3311): it answers
            // Esc for the open panel and is what the primitive searches to hand focus
            // back to the chip that opened it.
            onKeyDown={onFactKeyDown}
          >
            <div className="mb-3 flex items-center gap-3">
              <h3 id="session-details-title" className="label mb-0 shrink-0">
                Session
              </h3>
              <span
                aria-hidden="true"
                className="h-px flex-1 bg-black/5 dark:bg-white/10"
              />
            </div>
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
              onStartTime={changeStartTime}
              onEndTime={changeEndTime}
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
              <IntensityPicker intensity={intensity} onChange={setIntensity} />

              {/* Session-level equipment (issue #342), stated as a fact rather than as
              its own machinery (#3334): the row said "Equipment", a <select> and a
              standing link on every non-strength session, whether or not the recency
              default it had already computed was wrong. The chip states that default;
              the picker — and the registry door inside it — is one tap behind.

              The cell stays mounted while the editor is open so the two-column grid
              keeps its shape and the intensity toggles do not resize under the person
              mid-edit. */}
              {sessionEquipmentType != null && (
                <div>
                  {openFact == null && (
                    <>
                      {/* The cell's own heading, matching the Intensity legend beside
                          it. It goes with the chips: the open panel renders the
                          picker's own "Equipment" label, and two of them on screen
                          would be one heading too many. */}
                      <div className="label">Equipment</div>
                      <ActivitySessionFactRow
                        summary={sessionFacts}
                        openEditor={openFact}
                        onOpen={openFactEditor}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
            {sessionEquipmentType != null && openFact != null && (
              <FactEditorHost
                testId="activity-fact-editor"
                doneTestId="activity-fact-editor-done"
                panel={openFact}
                className="mt-3 rounded-lg border border-(--border) bg-surface p-3"
                onDone={closeFactEditor}
              >
                <ActivityEquipmentPicker
                  activityType={sessionEquipmentType}
                  activityName={sessionEquipmentName}
                  equipment={equipmentList}
                  value={effectiveActivityEquipmentId}
                  compact
                  onChange={(id) => {
                    setActivityEquipmentId(id);
                  }}
                />
              </FactEditorHost>
            )}
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
            // The SAVED row id — the same resolution the video/clip surfaces
            // already use (#1520): the edited row, or the one autosave created
            // for this create-mode form. Null until that row exists.
            activityId={editData?.id ?? createdId}
            distanceUnit={units.distanceUnit}
            onRevealPopulated={revealMoreDetails}
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

          {/* A retriable-failure episode (#2866): saves are dying on the shapes a
              deploy's swap window produces and the bounded backoff is re-attempting
              on its own. Say what is TRUE — the local draft (#1699) holds every
              entry — instead of leaving a bare triangle to narrate the outage. The
              stale-build banner outranks this (retrying cannot help a stale build). */}
          {retryingSave && !staleBuild && !blocker && (
            <p
              className="-mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
              role="status"
              data-testid="autosave-retrying"
            >
              <IconAlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                Not saving right now — your entries are kept on this device.
              </span>
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
            onFinish={canFinishInForm ? openFinishRecap : undefined}
            showDone={!liveMode}
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
          onCreated={addEquipment}
          onClose={() => setPlateTarget(null)}
        />
      )}
    </form>
  );
}
