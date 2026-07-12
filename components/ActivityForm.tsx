"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  saveActivity,
  deleteActivity,
  logBodyweight,
} from "@/app/(app)/journal/actions";
import type { ActivityType, Equipment } from "@/lib/types";
import { parseComponents } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import {
  muscleFor,
  isUnilateral,
  isBodyweight,
  variantOf,
  composeVariant,
  baseLiftName,
  exerciseHistoryKey,
} from "@/lib/lifts";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import {
  inferFreeTextType,
  legacyActivityName,
  minutesBetween,
  titleCase,
} from "@/lib/activity-meta";
import { isCuratedActivity } from "@/lib/activities-catalog";
import { biasByCompanions } from "@/lib/companions";
import {
  summarizeEquipmentAvailability,
  deRankUnavailableLifts,
} from "@/lib/equipment-availability";
import { dispWeight, kmTo, round } from "@/lib/units";
import { saveOutcomeMessage } from "@/lib/activity-save-outcome";
import { type NextSet } from "@/lib/coaching";
import { IconX, IconAlertTriangle } from "@tabler/icons-react";
import ActivityCombobox from "./ActivityCombobox";
import PlateBuilderModal from "./PlateBuilderModal";
import { isRealIsoDate } from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  type ActivityEditData,
  type PartEntry,
  type SetEntry,
  blankSet,
  blankPart,
  partIntent,
  groupEditSets,
  setComplete,
  setPartial,
  todayStr,
  nowHHMM,
} from "./activity-form/model";
import {
  makeNameClassifier,
  analyzeActivityForm,
  buildActivityPayload,
  generateActivityTitle,
} from "@/lib/activity-form-validate";
import CustomTypeChips from "./activity-form/CustomTypeChips";
import CardioFields from "./activity-form/CardioFields";
import StrengthSets from "./activity-form/StrengthSets";
import ActivityEquipmentPicker from "./activity-form/ActivityEquipmentPicker";
import ActivityFormHeader from "./activity-form/ActivityFormHeader";
import DateTimeFields from "./activity-form/DateTimeFields";
import NotesField from "./activity-form/NotesField";
import IntensityPicker from "./activity-form/IntensityPicker";
import EstimatedCalories from "./activity-form/EstimatedCalories";
import ActivityFormFooter from "./activity-form/ActivityFormFooter";
import {
  equipmentForActivity,
  pickDefaultActivityEquipment,
  usesActivityEquipment,
} from "@/lib/activity-equipment";
import { estimateActivityKcal } from "@/lib/calorie-estimate";

// Re-exported so existing callers keep importing the edit-payload shape from
// this module; the definition now lives in ./activity-form/model.
export type { ActivityEditData };

// The shared activity create/edit form, rendered inside ActivityOverlay or docked
// in the journal's right column. Either way it auto-saves: changes persist a
// moment after any valid edit (create-then-update), so every way of leaving the
// form — close button, backdrop, Escape, navigation — is loss-free and there is
// no Save/Cancel step.
export default function ActivityForm({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  editData,
  prefill = null,
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
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );
  // Timestamp of the last successful save; drives SaveStatus's check + fade.
  const [savedAt, setSavedAt] = useState(0);
  // After an auto-save creates a fresh row, remember its id so later saves update
  // it (the ref is read synchronously by saves; the state drives the UI).
  const [createdId, setCreatedId] = useState<number | null>(null);
  const createdIdRef = useRef<number | null>(null);
  const savableId = () => editData?.id ?? createdIdRef.current;
  const hasRow = !!editData || createdId != null;
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
  // Which set's weight field the plate builder is targeting, if open. `seed`
  // (display-unit weight) pre-loads the builder from the coached suggestion
  // instead of the field's current value (#335); omitted for a plain icon tap.
  const [plateTarget, setPlateTarget] = useState<{
    pi: number;
    si: number;
    field: "weight" | "weightRight";
    seed?: number;
  } | null>(null);

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
  const [notesOpen, setNotesOpen] = useState<boolean>(() => {
    if (editData?.notes) return true;
    if (typeof window !== "undefined")
      return sessionStorage.getItem("activityNotesOpen") === "1";
    return false;
  });

  const [parts, setParts] = useState<PartEntry[]>(() => {
    if (!seed) return [blankPart()];
    if (seed.components) {
      // Shared parseComponents (issue #334): a stored components string is always
      // a valid non-empty array (saveActivity writes NULL for an empty list), so
      // this loads the structured parts; a malformed blob yields [] here.
      const grouped = groupEditSets(seed.sets, units.weightUnit);
      return parseComponents(seed.components).map((c) => {
        if (c.type === "strength") {
          const g = grouped.find(
            (e) => e.name.toLowerCase() === c.name.toLowerCase()
          );
          // Spread the reconstructed part wholesale (keeping the component's
          // casing for the name) so new EditedPart fields can't be missed.
          return g
            ? { ...blankPart(), ...g, name: c.name }
            : { ...blankPart(), name: c.name };
        }
        // Any non-curated cardio/sport name is a custom activity: load it
        // committed and typed as stored, whether or not the suggestions
        // know it yet — so its chips and distance field survive re-edits.
        const custom = !isCuratedActivity(c.name);
        return {
          ...blankPart(),
          name: c.name,
          custom,
          customType: custom ? c.type : null,
          distance:
            c.distance_km != null
              ? String(round(kmTo(c.distance_km, units.distanceUnit), 2))
              : "",
          durationMin: c.duration_min != null ? String(c.duration_min) : "",
        };
      });
    }
    if (seed.type === "strength") {
      const g = groupEditSets(seed.sets, units.weightUnit);
      return (g.length ? g : [blankPart()]).map((e) => ({
        ...blankPart(),
        ...e,
      }));
    }
    // Legacy cardio/sport rows (no components): the part name is derived
    // from the freeform title (see legacyActivityName); a non-curated one
    // loads as a custom part typed by the row — editable instead of
    // permanently blocked.
    const name = legacyActivityName(seed.title, isKnown);
    const custom = !isCuratedActivity(name);
    return [
      {
        ...blankPart(),
        name,
        custom,
        customType: custom ? seed.type : null,
        distance:
          seed.distance_km != null
            ? String(round(kmTo(seed.distance_km, units.distanceUnit), 2))
            : "",
        durationMin: seed.duration_min != null ? String(seed.duration_min) : "",
      },
    ];
  });

  const isEdit = !!editData;
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
  const { namedParts, timeError, canSave, canAddPart } = analysis;
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
  const firstValid = namedParts[0];
  const headingType = firstValid ? partType(firstValid) : null;

  // Auto-computed calorie ESTIMATE for this (manual) draft: the MET dataset × this
  // profile's bodyweight × the activity's duration (issue #151). null when there's
  // no bodyweight on record, no usable duration, or nothing valid entered yet — the
  // field then stays empty rather than showing a fabricated number.
  const autoEstimateKcal = useMemo(() => {
    if (bodyweightKg == null || namedParts.length === 0) return null;
    const { comps, primaryType } = buildActivityPayload(classifier, namedParts);
    return estimateActivityKcal(
      {
        type: primaryType,
        title: effectiveTitle,
        intensity: intensity || null,
        duration_min: overallDuration,
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
    overallDuration,
  ]);
  // Keep the field tracking the auto-estimate until the user types their own.
  useEffect(() => {
    if (estEdited) return;
    setEstCalories(autoEstimateKcal != null ? String(autoEstimateKcal) : "");
  }, [autoEstimateKcal, estEdited]);
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
  }, [plateTarget]);

  function updatePart(i: number, patch: Partial<PartEntry>) {
    setParts((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    );
  }
  // Set the part's name, defaulting the per-side toggle: a bilateral lift is
  // never per-side; a unilateral lift defaults on when its most recent session
  // was logged per-side (when freshly logging, not editing). Variant lifts pick
  // their equipment via chips, which call this with the composed name.
  // `extra` merges into the same state update, so callers adjusting sibling
  // fields (equipment, custom flags) don't queue a second parts clone.
  function updatePartName(i: number, name: string, extra?: Partial<PartEntry>) {
    setParts((prev) =>
      prev.map((p, idx) => {
        if (idx !== i) return p;
        if (!isUnilateral(name))
          return { ...p, ...extra, name, perSide: false };
        if (isEdit) return { ...p, ...extra, name }; // keep the toggle as loaded
        const latest = history[exerciseHistoryKey(name)]?.sessions[0];
        const perSide = !!latest?.sets.some(
          (s) =>
            s.weight_kg_right != null ||
            s.reps_right != null ||
            s.duration_sec_right != null
        );
        return { ...p, ...extra, name, perSide };
      })
    );
  }
  // The most recent implement used for a variant base (across all its variants):
  // the composed variant name plus any custom implement id, or null if untrained.
  // History merges a base's variants under one canonical key (#331), so the base's
  // most recent session is history[exerciseHistoryKey(base)].sessions[0]; that
  // session's own logged name recovers which concrete variant was last used.
  function lastUsedVariant(
    base: string
  ): { name: string; equipmentId: number | null } | null {
    const s = history[exerciseHistoryKey(base)]?.sessions[0];
    if (!s) return null;
    const v = variantOf(s.exercise);
    const name = v
      ? v.equipment
        ? composeVariant(v.group, v.equipment)
        : v.group.name
      : s.exercise;
    const equipmentId = s.equipment
      ? (equipmentList.find(
          (e) => e.name.toLowerCase() === s.equipment!.toLowerCase()
        )?.id ?? null)
      : null;
    return { name, equipmentId };
  }
  // The custom implement id used in the most recent session of an exercise. The
  // merged history is keyed by the canonical base (#331); prefer the newest
  // session logged under the exact name, else the base's newest session.
  function lastEquipmentId(name: string): number | null {
    const sessions = history[exerciseHistoryKey(name)]?.sessions;
    if (!sessions?.length) return null;
    const exact = name.trim().toLowerCase();
    const s =
      sessions.find((se) => se.exercise.trim().toLowerCase() === exact) ??
      sessions[0];
    const eqName = s.equipment;
    if (!eqName) return null;
    return (
      equipmentList.find((e) => e.name.toLowerCase() === eqName.toLowerCase())
        ?.id ?? null
    );
  }
  // Actively picking an exercise from the combobox (create OR edit) defaults to
  // the implement used last for it — a variant base resolves to its last-used
  // variant; other lifts restore any custom implement previously used.
  function selectPartName(i: number, rawName: string) {
    const v = variantOf(rawName);
    if (v && v.equipment === null) {
      // Variant base → resolve to a concrete variant so it's never left bare:
      // the implement used last for it, else the group's first equipment
      // (usually Barbell). The user can still switch via the chips.
      const last = lastUsedVariant(rawName);
      if (last) {
        updatePartName(i, last.name, { equipmentId: last.equipmentId });
      } else {
        updatePartName(i, composeVariant(v.group, v.group.equipment[0]), {
          equipmentId: null,
        });
      }
      return;
    }
    updatePartName(i, rawName, { equipmentId: lastEquipmentId(rawName) });
  }
  // Typing in the combobox: a plain name update (keeping updatePartName's
  // per-side defaulting and the last-used-implement sync) that re-derives the
  // custom flags from the text — a novel free-text commit only survives an
  // explicit pick. Variant bases are NOT resolved here; doing that per
  // keystroke would rewrite mid-word names under the user's cursor.
  function typePartName(i: number, v: string) {
    updatePartName(i, v, {
      ...customFlags(v),
      equipmentId: lastEquipmentId(v),
    });
  }
  // Explicit pick from the dropdown — a known option or the "Add '<x>' as new
  // activity" row. Novel names commit as custom parts, title-cased so the
  // commit is visible, typed by keyword inference (chips shown either way).
  // Known names (Combobox fires onChange with the pick first, so the custom
  // flags are already set by typePartName) get the pick-time defaults.
  function pickPartName(i: number, rawName: string) {
    if (isKnown(rawName)) {
      selectPartName(i, rawName);
      return;
    }
    const name = titleCase(rawName.trim());
    updatePart(i, {
      name,
      custom: true,
      customType: inferFreeTextType(name),
      equipmentId: null,
      perSide: false,
    });
  }
  function updateSet(pi: number, si: number, patch: Partial<SetEntry>) {
    setParts((prev) =>
      prev.map((p, idx) =>
        idx === pi
          ? {
              ...p,
              sets: p.sets.map((s, j) => (j === si ? { ...s, ...patch } : s)),
            }
          : p
      )
    );
  }
  function addSet(pi: number) {
    setParts((prev) =>
      prev.map((p, idx) => {
        if (idx !== pi) return p;
        const last = p.sets[p.sets.length - 1];
        return {
          ...p,
          sets: [
            ...p.sets,
            {
              weight: last?.weight ?? "",
              reps: last?.reps ?? "",
              weightRight: last?.weightRight ?? "",
              repsRight: last?.repsRight ?? "",
              duration: last?.duration ?? "",
              durationRight: last?.durationRight ?? "",
            },
          ],
        };
      })
    );
  }
  function removeSet(pi: number, si: number) {
    setParts((prev) =>
      prev.map((p, idx) =>
        idx === pi ? { ...p, sets: p.sets.filter((_, j) => j !== si) } : p
      )
    );
  }
  // Fill in the suggested next set: into the last set row if it's still
  // untouched, else as a new set. The canonical-kg suggestion is entered in the
  // user's unit (for lb users it's already snapped to a loadable multiple of
  // 5 lb, so this round-trips exactly). When the suggestion progresses a
  // declared rep target, adopt it as the exercise's intent — unless the user
  // already set one — so the scheme carries into the next session too.
  // Bilateral parts only: the single suggested value seeds from the STRONGER
  // side of a per-side lift, so filling both sides would over-load the weaker
  // one (the card hides its Use button for per-side parts).
  function applySuggestion(pi: number, ns: NextSet) {
    const p = parts[pi];
    const weight = ns.bodyweight
      ? ""
      : String(dispWeight(ns.weightKg, units.weightUnit, 1));
    const reps = String(ns.reps);
    const patch: Partial<SetEntry> = { weight, reps };
    const li = p.sets.length - 1;
    const last = p.sets[li];
    const untouched =
      !!last &&
      !setComplete(p.name, last, p.perSide) &&
      !setPartial(p.name, last, p.perSide);
    if (untouched) updateSet(pi, li, patch);
    else
      setParts((prev) =>
        prev.map((part, idx) =>
          idx === pi
            ? { ...part, sets: [...part.sets, { ...blankSet(), ...patch }] }
            : part
        )
      );
    if (
      ns.targetReps != null &&
      partIntent(p).applies &&
      !p.targetReps.trim() &&
      !p.toFailure
    )
      updatePart(pi, { targetReps: String(ns.targetReps) });
  }
  // Fill the suggested next set for a per-side lift (#335): each side is seeded
  // from its OWN progression (left off left history, right off right), so the
  // weaker side is never loaded off the stronger one. Into the untouched last
  // row if still blank, else as a new set — mirroring applySuggestion.
  function applyPerSideSuggestion(
    pi: number,
    left: NextSet | null,
    right: NextSet | null
  ) {
    const p = parts[pi];
    const patch: Partial<SetEntry> = {};
    if (left) {
      patch.weight = left.bodyweight
        ? ""
        : String(dispWeight(left.weightKg, units.weightUnit, 1));
      patch.reps = String(left.reps);
    }
    if (right) {
      patch.weightRight = right.bodyweight
        ? ""
        : String(dispWeight(right.weightKg, units.weightUnit, 1));
      patch.repsRight = String(right.reps);
    }
    const li = p.sets.length - 1;
    const last = p.sets[li];
    const untouched =
      !!last &&
      !setComplete(p.name, last, p.perSide) &&
      !setPartial(p.name, last, p.perSide);
    if (untouched) updateSet(pi, li, patch);
    else
      setParts((prev) =>
        prev.map((part, idx) =>
          idx === pi
            ? { ...part, sets: [...part.sets, { ...blankSet(), ...patch }] }
            : part
        )
      );
  }
  // Suggestion → plate-builder deep link (#335): open the builder seeded with the
  // suggested load (converted to the display unit) targeting set 1's weight, so a
  // barbell lifter goes straight from "add 2.5 kg" to a loaded bar.
  function plateFromSuggestion(pi: number, weightKg: number) {
    const p = parts[pi];
    const si = Math.max(0, p.sets.length - 1);
    setPlateTarget({
      pi,
      si,
      field: "weight",
      seed: dispWeight(weightKg, units.weightUnit, 1),
    });
  }
  // Apply a plate-builder result to the targeted set weight. Auto-tag the
  // exercise with the bar only when no implement is chosen yet — never silently
  // replace a deliberate selection (the equipment dropdown changes it instead).
  function applyPlateBuild(total: number, barId: number | null) {
    if (!plateTarget) return;
    const { pi, si, field } = plateTarget;
    updateSet(pi, si, { [field]: String(total) });
    if (barId != null && parts[pi]?.equipmentId == null)
      updatePart(pi, { equipmentId: barId });
    setPlateTarget(null);
  }
  function toggleNotes() {
    setNotesOpen((v) => {
      const next = !v;
      sessionStorage.setItem("activityNotesOpen", next ? "1" : "0");
      return next;
    });
  }

  // Build the FormData saveActivity expects from the current state. Callers gate
  // on `canSave` first. Uses the live row id (existing or auto-created) so saves
  // update in place rather than inserting duplicates.
  function buildFormData(): FormData {
    const { comps, flat, primaryType } = buildActivityPayload(
      classifier,
      namedParts
    );

    const fd = new FormData();
    const id = savableId();
    if (id != null) fd.set("id", String(id));
    fd.set("type", primaryType);
    fd.set("title", effectiveTitle);
    fd.set("date", date);
    fd.set("components", JSON.stringify(comps));
    fd.set("sets", JSON.stringify(flat));
    if (notes.trim()) fd.set("notes", notes.trim());
    if (startTime) fd.set("start_time", startTime);
    if (endTime) fd.set("end_time", endTime);
    if (intensity) fd.set("intensity", intensity);
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
      activityEquipmentId,
    ]
  );
  // The state we last persisted (or loaded). Starts equal to the initial state
  // so loading existing data — or opening a blank create form — saves nothing.
  // A "Log again"/"Repeat last" prefill is the exception: it starts DIFFERENT
  // (an empty sentinel) so the seeded, already-complete activity auto-saves as a
  // new row on open without needing an edit first.
  const savedSigRef = useRef<string>(prefill && !editData ? "" : formSig);
  // Keep the latest persist available to the unmount flush without re-running it.
  const persistRef = useRef<() => void>(() => {});
  // Serialize saves: only one in flight at a time, so concurrent debounces can't
  // both create a fresh row before the first returns its id (duplicate insert).
  const inFlightRef = useRef(false);
  // Avoid setState after unmount (the unmount flush awaits a server action).
  // Set true on mount too: under StrictMode the mount→cleanup→mount cycle would
  // otherwise leave it stuck false, skipping post-save state (Delete, status).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function persist() {
    if (!canSave) return;
    if (formSig === savedSigRef.current) return; // nothing changed
    if (inFlightRef.current) return; // a save is running; its trailing re-check catches new edits
    inFlightRef.current = true;
    const sigAtSave = formSig;
    let saved = false;
    if (mountedRef.current) setStatus("saving");
    try {
      const res = await saveActivity(buildFormData());
      // Nothing persisted (invalid title/date or an id the active profile doesn't
      // own — e.g. after a profile switch). Do NOT advance savedSigRef: the form
      // stays dirty so the edit survives, the auto-saver can retry, and closing it
      // still prompts. Surface the failure instead of a false "Saved ✓" (#332).
      if (!res.ok) {
        if (mountedRef.current) setStatus("error");
        else toast(saveOutcomeMessage(res.reason));
        return;
      }
      if (res.id != null && savableId() == null) {
        createdIdRef.current = res.id; // ref first, so a trailing save UPDATEs
        if (mountedRef.current) setCreatedId(res.id);
      }
      savedSigRef.current = sigAtSave;
      saved = true;
      if (mountedRef.current) {
        setStatus("saved");
        setSavedAt(Date.now());
      }
      router.refresh();
    } catch {
      if (mountedRef.current) setStatus("error");
      // Failed after the form closed (the unmount flush): the status icon is
      // gone, so this toast is the only signal the change didn't stick.
      else toast("Couldn’t save your last change — reopen the activity.");
    } finally {
      inFlightRef.current = false;
      // Persist edits that landed while this save was in flight — even after
      // unmount, since the unmount flush skips while a save is running. Only
      // after a success though: chaining after a failure would retry in a loop.
      if (saved) void persistRef.current();
    }
  }
  persistRef.current = persist;

  useEffect(() => {
    if (formSig === savedSigRef.current) return; // unchanged (incl. first mount)
    if (!canSave) return;
    const h = setTimeout(() => void persistRef.current(), 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSig, canSave]);

  // Flush any pending change when the form goes away (e.g. switching cards,
  // dismissing the modal, navigating off the page).
  useEffect(() => {
    return () => void persistRef.current();
  }, []);

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
      // Don't let the unmount flush re-create the row we just deleted.
      savedSigRef.current = formSig;
      createdIdRef.current = null;
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
      await logBodyweight(w, date);
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
  const dirty = formSig !== savedSigRef.current;
  const blocker = (dirty || hasRow) && !canSave ? analysis.saveBlocker : null;

  // Auto-save can't persist a blocked form, so closing one with unsaved edits
  // to a real row would silently drop them — confirm first. A blocked blank
  // create is exempt: discarding it is the natural "cancel".
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
    onClose();
  }
  requestCloseRef.current = requestClose;

  return (
    <form
      // The form never submits on Enter — the debounced auto-save handles
      // persistence, so a stray Enter (e.g. right after picking from the
      // combobox) does nothing rather than forcing a premature save.
      // preventDefault also stops a full-page reload.
      onSubmit={(e) => e.preventDefault()}
      className="space-y-5"
    >
      <ActivityFormHeader
        headingType={headingType}
        headingTitle={firstValid?.name}
        effectiveTitle={effectiveTitle}
        date={date}
        editData={editData}
        onClose={requestClose}
      />

      {/* Editable name — auto-filled from the activities below until you change it. */}
      <div>
        <label className="label">Name</label>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleEdited(true);
          }}
          placeholder={
            liveTitle === "New activity" ? "Activity name" : liveTitle
          }
          className="input"
        />
      </div>

      {/* Activities — one or more parts, each chosen from the dropdown */}
      <div className="space-y-3">
        {parts.map((p, pi) => {
          const t = partType(p);
          const valid = t !== null;
          const muscle = t === "strength" ? muscleFor(p.name) : null;
          // Hoist companions of the OTHER entered lifts to the top of this
          // part's picker (issue #195); excludes this part's own name so it
          // can't bias its own list. No-op until a lift is entered.
          const selfBase = p.name.trim()
            ? baseLiftName(p.name).trim().toLowerCase()
            : "";
          const biasedOptions = biasByCompanions(
            equipmentRankedOptions,
            enteredLiftBases.filter((n) => n !== selfBase),
            suggestions.liftCompanions
          );
          // While a change is stuck on this part, the specific fields at fault
          // are highlighted (in StrengthSets/CardioFields); the equipment fault
          // also gets its inline hint below.
          const issue = blocker ? partIssue(p) : null;
          return (
            <div
              key={pi}
              className="rounded-lg border border-black/10 bg-slate-50 p-3 dark:border-white/10 dark:bg-ink-900"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ActivityCombobox
                    value={p.name}
                    onChange={(v) => typePartName(pi, v)}
                    onPick={(v) => pickPartName(pi, v)}
                    allowFreeText
                    // Composed variant names ("Dumbbell Curl") aren't in the
                    // options list but pick as the known lift — don't promise
                    // a new activity the pick won't create.
                    freeTextLabel={(q) =>
                      isKnown(q) ? (
                        <>Use “{q}”</>
                      ) : (
                        <>Add “{q}” as new activity</>
                      )
                    }
                    options={biasedOptions}
                    placeholder={
                      pi === 0
                        ? "What did you do? e.g. Bench Press, Running, Tennis"
                        : "Add another activity…"
                    }
                    autoFocus={pi === 0 && !isEdit}
                    // A committed custom part isn't "unrecognized" — its
                    // pending type shows as amber chips, not a red border.
                    invalid={p.name.trim() !== "" && !valid && !p.custom}
                    badge={
                      muscle ? (
                        <span className="badge bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                          {muscle}
                        </span>
                      ) : undefined
                    }
                    badgeFor={(opt) => {
                      const m = muscleFor(opt);
                      return m ? (
                        <span className="badge shrink-0 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                          {m}
                        </span>
                      ) : null;
                    }}
                  />
                </div>
                {parts.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setParts((prev) => prev.filter((_, i) => i !== pi))
                    }
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-500/80 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                    aria-label="Remove activity"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* Chips sit outside the `valid` gates: a typeless custom part
                  renders neither block, and the chips are what unblock it. */}
              {p.custom && p.name.trim() !== "" && (
                <CustomTypeChips
                  activeType={t}
                  fault={issue}
                  onPick={(ct) =>
                    updatePart(pi, { custom: true, customType: ct })
                  }
                />
              )}
              {valid && t === "strength" && (
                <StrengthSets
                  part={p}
                  fault={issue}
                  units={units}
                  isEdit={isEdit}
                  history={history}
                  currentActivityId={editData?.id ?? createdId}
                  editedDate={editData?.date ?? null}
                  equipmentList={equipmentList}
                  showBodyweightPrompt={!bwKnown && pi === firstBwPart}
                  bwInput={bwInput}
                  bwSaving={bwSaving}
                  onBwInput={setBwInput}
                  onSaveBodyweight={saveBodyweight}
                  onUpdatePart={(patch) => updatePart(pi, patch)}
                  onUpdateSet={(si, patch) => updateSet(pi, si, patch)}
                  onAddSet={() => addSet(pi)}
                  onRemoveSet={(si) => removeSet(pi, si)}
                  onUpdatePartName={(name, extra) =>
                    updatePartName(pi, name, extra)
                  }
                  onApplySuggestion={(ns) => applySuggestion(pi, ns)}
                  onApplyPerSideSuggestion={(left, right) =>
                    applyPerSideSuggestion(pi, left, right)
                  }
                  onPlateFromSuggestion={(weightKg) =>
                    plateFromSuggestion(pi, weightKg)
                  }
                  onPlateTarget={(si, field) =>
                    setPlateTarget({ pi, si, field })
                  }
                />
              )}
              {valid && t !== "strength" && (
                <CardioFields
                  part={p}
                  showDist={partNeedsDistance(p)}
                  distanceUnit={units.distanceUnit}
                  fault={issue}
                  onDistance={(v) => updatePart(pi, { distance: v })}
                  onDurationMin={(v) => updatePart(pi, { durationMin: v })}
                />
              )}
              {issue === "type" && (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Choose cardio or sport to save. Strength exercises must be
                  picked from the list.
                </p>
              )}
              {issue === "equipment" && (
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Choose equipment to save this activity.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setParts((prev) => [...prev, blankPart()])}
        disabled={!canAddPart}
        title={
          canAddPart
            ? "Add another activity"
            : "Complete the current activity first"
        }
        className="btn-ghost disabled:cursor-not-allowed disabled:opacity-50"
      >
        + Add activity
      </button>

      <DateTimeFields
        date={date}
        startTime={startTime}
        endTime={endTime}
        tz={tz}
        timeError={timeError}
        overallDuration={overallDuration}
        onDate={setDate}
        onStartTime={setStartTime}
        onEndTime={setEndTime}
      />

      <NotesField
        notesOpen={notesOpen}
        notes={notes}
        onToggle={toggleNotes}
        onNotesChange={setNotes}
      />

      <IntensityPicker intensity={intensity} onChange={setIntensity} />

      {/* Session-level equipment (issue #342): the gear the whole non-strength
          activity used — a ride's bike, a run's shoes. Hidden for pure-strength
          sessions (gear is per-set there) and when the profile owns no fitting
          gear. Reusable across every non-strength surface (#339/#344). */}
      {sessionEquipmentType != null && (
        <ActivityEquipmentPicker
          activityType={sessionEquipmentType}
          activityName={sessionEquipmentName}
          equipment={equipmentList}
          value={activityEquipmentId}
          onChange={(id) => {
            equipmentTouchedRef.current = true;
            setActivityEquipmentId(id);
          }}
        />
      )}

      {/* Estimated calories (issue #151). Auto-filled from the MET dataset × this
          profile's bodyweight × duration, and editable — the user can override it.
          Shown only for manual activities (imported rows carry device energy). The
          "Estimated" label marks it as an estimate, distinct from measured. */}
      {showEstimate && (
        <EstimatedCalories
          value={estCalories}
          edited={estEdited}
          autoEstimateKcal={autoEstimateKcal}
          onChange={(v) => {
            setEstCalories(v);
            setEstEdited(true);
          }}
          onReset={() => {
            setEstEdited(false);
            setEstCalories(String(autoEstimateKcal));
          }}
        />
      )}

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
