"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  saveActivity,
  deleteActivity,
  logBodyweight,
} from "@/app/(app)/journal/actions";
import type { ActivityType, ActivityComponent, Equipment } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import {
  muscleFor,
  suggestTitle,
  isUnilateral,
  isTimed,
  isBodyweight,
  variantOf,
  composeVariant,
  baseLiftName,
} from "@/lib/lifts";
import { parseSeconds, isValidDuration } from "@/lib/duration";
import { formatLongDate } from "@/lib/format-date";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import {
  inferFreeTextType,
  legacyActivityName,
  showsDistanceField,
  timeOfDay,
  minutesBetween,
  titleCase,
} from "@/lib/activity-meta";
import { isCuratedActivity } from "@/lib/activities-catalog";
import { dispWeight, kmTo, round } from "@/lib/units";
import { type NextSet } from "@/lib/coaching";
import {
  IconX,
  IconChevronDown,
  IconChevronRight,
  IconAlertTriangle,
} from "@tabler/icons-react";
import ActivityCombobox from "./ActivityCombobox";
import ActivityIcon from "./ActivityIcon";
import DateField from "./DateField";
import PlateBuilderModal from "./PlateBuilderModal";
import { isRealIsoDate } from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import SaveStatus from "@/components/SaveStatus";
import {
  type ActivityEditData,
  type PartEntry,
  type SetEntry,
  blankSet,
  blankPart,
  partIntent,
  groupEditSets,
  setComplete,
  sideComplete,
  setPartial,
  todayStr,
  nowHHMM,
  INTENSITIES,
} from "./activity-form/model";
import CustomTypeChips from "./activity-form/CustomTypeChips";
import CardioFields from "./activity-form/CardioFields";
import StrengthSets from "./activity-form/StrengthSets";

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
  bodyweightKg,
  editData,
  onClose,
  stickyFooter = false,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  bodyweightKg: number | null;
  editData: ActivityEditData | null;
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

  const nameType = (name: string): ActivityType | null => {
    const t = typeByName.get(name.trim().toLowerCase());
    if (t) return t;
    // Composed variant names ("Dumbbell Curl") aren't in the grouped picker
    // list but are real strength lifts.
    if (variantOf(name)) return "strength";
    return null;
  };
  const isKnown = (name: string) => nameType(name) !== null;
  // A user-coined cardio/sport name: in the vocabulary (previously logged)
  // but not curated. Such names load and re-pick as custom parts, keeping
  // their chips and distance field in every session, not just the first.
  const isCoined = (name: string) => {
    const t = nameType(name);
    return t !== null && t !== "strength" && !isCuratedActivity(name);
  };
  // A part's effective type. A nameless part has none (imported components
  // can carry blank names — they must not count as savable). For custom
  // parts the chip/inferred/stored choice is the only source: every path
  // that sets `custom` also resolves `customType` (null only for a novel
  // name awaiting its chip, where the vocabulary is empty-handed anyway).
  const partType = (p: PartEntry): ActivityType | null => {
    if (!p.name.trim()) return null;
    return p.custom ? p.customType : nameType(p.name);
  };
  const partNeedsDistance = (p: PartEntry) =>
    showsDistanceField(p.name, partType(p), p.custom);

  // Local copy so a bar created from the plate builder appears immediately in
  // both the equipment selector and the builder without waiting on a refetch.
  const [equipmentList, setEquipmentList] = useState<Equipment[]>(equipment);
  // Which set's weight field the plate builder is targeting, if open.
  const [plateTarget, setPlateTarget] = useState<{
    pi: number;
    si: number;
    field: "weight" | "weightRight";
  } | null>(null);

  // Lazy initializers: the fallbacks format dates, no need to redo that work on
  // every render just to discard it.
  const [date, setDate] = useState(() => editData?.date ?? todayStr(tz));
  const [startTime, setStartTime] = useState(() =>
    editData ? (editData.start_time ?? "") : nowHHMM(tz)
  );
  const [endTime, setEndTime] = useState(editData?.end_time ?? "");
  const [intensity, setIntensity] = useState(editData?.intensity ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");
  // Editable activity name. For new activities it tracks the auto-generated
  // title until the user types their own; for edits it keeps the saved title.
  const [title, setTitle] = useState(editData?.title ?? "");
  const [titleEdited, setTitleEdited] = useState(!!editData);
  const [notesOpen, setNotesOpen] = useState<boolean>(() => {
    if (editData?.notes) return true;
    if (typeof window !== "undefined")
      return sessionStorage.getItem("activityNotesOpen") === "1";
    return false;
  });

  const [parts, setParts] = useState<PartEntry[]>(() => {
    if (!editData) return [blankPart()];
    if (editData.components) {
      try {
        const comps: ActivityComponent[] = JSON.parse(editData.components);
        const grouped = groupEditSets(editData.sets, units.weightUnit);
        return comps.map((c) => {
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
      } catch {
        // fall through to legacy handling
      }
    }
    if (editData.type === "strength") {
      const g = groupEditSets(editData.sets, units.weightUnit);
      return (g.length ? g : [blankPart()]).map((e) => ({
        ...blankPart(),
        ...e,
      }));
    }
    // Legacy cardio/sport rows (no components): the part name is derived
    // from the freeform title (see legacyActivityName); a non-curated one
    // loads as a custom part typed by the row — editable instead of
    // permanently blocked.
    const name = legacyActivityName(editData.title, isKnown);
    const custom = !isCuratedActivity(name);
    return [
      {
        ...blankPart(),
        name,
        custom,
        customType: custom ? editData.type : null,
        distance:
          editData.distance_km != null
            ? String(round(kmTo(editData.distance_km, units.distanceUnit), 2))
            : "",
        durationMin:
          editData.duration_min != null ? String(editData.duration_min) : "",
      },
    ];
  });

  const isEdit = !!editData;
  // A bare variant base ("Curl") still needs an equipment chip picked before it
  // is a concrete, savable lift.
  const needsEquipment = (name: string) => variantOf(name)?.equipment === null;
  const namedParts = parts.filter((p) => partType(p) !== null);
  // A committed custom part has a valid *name*; a missing type is its own
  // fault (typeMissing) with its own chips to fix it.
  const allNamedValid = parts.every(
    (p) => !p.name.trim() || isKnown(p.name) || p.custom
  );
  const typeMissing = parts.some(
    (p) => p.custom && p.name.trim() !== "" && partType(p) === null
  );
  // A bare variant base needs equipment — satisfied by a variant chip (which
  // makes the name concrete) or a chosen custom implement.
  const allEquipmentChosen = namedParts.every(
    (p) => !needsEquipment(p.name) || p.equipmentId != null
  );
  // Every entered hold time on a timed lift must be well-formed (m:ss or seconds).
  const durationsValid = namedParts.every((p) => {
    if (partType(p) !== "strength" || !isTimed(p.name)) return true;
    return p.sets.every(
      (s) =>
        (!s.duration.trim() || isValidDuration(s.duration)) &&
        (!p.perSide ||
          !s.durationRight.trim() ||
          isValidDuration(s.durationRight))
    );
  });
  const timeError = !!startTime && !!endTime && endTime < startTime;
  // Every named exercise must carry its own content — a bare name can't be saved
  // on the strength of a sibling's data or the session's time range alone (which
  // is how a stray Enter used to auto-create an empty activity). A strength part
  // needs a completed set (weight/reps or a hold time); a cardio/sport part needs
  // a distance or duration, or a full start–end time range to stand in for one.
  const timeRange = !!startTime && !!endTime && !timeError;
  // Only a distance the save will actually keep counts as content — a value
  // stranded in state after its field hid (e.g. a cardio part switched to
  // sport) must pause the save, not let it author a contentless component.
  const partHasContent = (p: PartEntry) =>
    partType(p) === "strength"
      ? p.sets.some((s) => setComplete(p.name, s, p.perSide))
      : (partNeedsDistance(p) && !!p.distance.trim()) ||
        !!p.durationMin.trim() ||
        timeRange;
  const hasContent = namedParts.every(partHasContent);
  const partHasPartialSet = (p: PartEntry) =>
    partType(p) === "strength" &&
    p.sets.some((s) => setPartial(p.name, s, p.perSide));
  const noPartialSets = namedParts.every((p) => !partHasPartialSet(p));
  // The date field accepts raw text (DateField's onChange passes the unparsed
  // value) and the docked editor never runs native submit validation, so gate the
  // auto-save on a real ISO date — otherwise "2026-07" or "Friday" would persist.
  const dateValid = isRealIsoDate(date);
  const canSave =
    namedParts.length > 0 &&
    allNamedValid &&
    !typeMissing &&
    allEquipmentChosen &&
    durationsValid &&
    !timeError &&
    noPartialSets &&
    dateValid &&
    hasContent;

  const lastPart = parts[parts.length - 1];
  const lastType = lastPart ? partType(lastPart) : null;
  const canAddPart =
    lastType !== null &&
    (!needsEquipment(lastPart.name) || lastPart.equipmentId != null) &&
    (lastType !== "strength" ||
      lastPart.sets.some((s) =>
        setComplete(lastPart.name, s, lastPart.perSide)
      ));

  // --- Auto-save feedback ---
  // The docked editor has no Save button, so when a change can't persist there's
  // nothing to tell the user why. These pinpoint what's holding the save back.
  // Per-part fault (only for parts the user has named): the reason this activity
  // can't be saved, so its card can be flagged. `null` when the part is fine.
  const partIssue = (
    p: PartEntry
  ): "name" | "type" | "equipment" | "set" | "content" | null => {
    const name = p.name.trim();
    if (!name) return null; // a still-blank part isn't a fault, just unfinished
    if (!isKnown(name) && !p.custom) return "name";
    if (p.custom && partType(p) === null) return "type";
    if (needsEquipment(name) && p.equipmentId == null) return "equipment";
    if (partHasPartialSet(p)) return "set";
    if (!partHasContent(p)) return "content";
    return null;
  };
  // One short line naming the first thing blocking auto-save, evaluated in the
  // same order as canSave's clauses. `null` when the form is savable.
  // Kept in sync with lib/activity-validate's storedActivityFault, the
  // journal's card-level mirror of these rules over stored rows.
  const saveBlocker = (): string | null => {
    if (canSave) return null;
    // The typeless-custom message is needed at two spots (a lone typeless
    // part never reaches namedParts, so it lands in the first gate).
    const typeBlocker = "Choose a type for the new activity — cardio or sport.";
    if (namedParts.length === 0) {
      if (typeMissing) return typeBlocker;
      return parts.some((p) => p.name.trim())
        ? "Pick an activity from the list, or add it as a new one."
        : "Add an activity to start.";
    }
    if (!allNamedValid)
      return "An activity name isn’t recognized — pick it from the list or add it as new.";
    if (typeMissing) return typeBlocker;
    if (!allEquipmentChosen)
      return "Choose equipment for the highlighted activity.";
    if (!durationsValid) return "Enter the hold time as m:ss or seconds.";
    if (timeError) return "End time must be after the start time.";
    if (!noPartialSets)
      return "A set is only half-filled — finish it or clear it.";
    if (!hasContent) {
      // Point at the first activity still missing content, in its own terms.
      const empty = namedParts.find((p) => !partHasContent(p));
      return empty && partType(empty) === "strength"
        ? "Enter a set — weight & reps, or a hold time."
        : "Enter a distance, duration, or a start & end time.";
    }
    return null;
  };

  function generateTitle(): string {
    const tod = timeOfDay(startTime);
    const strengthNames = namedParts
      .filter((p) => partType(p) === "strength")
      .map((p) => p.name);
    const others = namedParts.filter((p) => partType(p) !== "strength");
    const otherStrs = others.map((p) =>
      titleCase(`${p.durationMin ? `${p.durationMin} Min ` : ""}${p.name}`)
    );
    const strengthTitle = strengthNames.length
      ? titleCase(suggestTitle(strengthNames))
      : null;

    let core: string;
    if (strengthTitle && otherStrs.length)
      core = `${strengthTitle} with ${otherStrs.join(" & ")}`;
    else if (strengthTitle) core = strengthTitle;
    else if (otherStrs.length) core = `${otherStrs.join(" & ")} Session`;
    else core = "New activity";

    return tod && core !== "New activity" ? `${tod} ${core}` : core;
  }

  const liveTitle = generateTitle();
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
        const latest = history[name.trim().toLowerCase()]?.sessions[0];
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
  function lastUsedVariant(
    base: string
  ): { name: string; equipmentId: number | null } | null {
    const baseKey = base.trim().toLowerCase();
    let best: { date: string; key: string; equipment: string | null } | null =
      null;
    for (const [key, h] of Object.entries(history)) {
      if (!h.sessions.length || baseLiftName(key).toLowerCase() !== baseKey)
        continue;
      const s = h.sessions[0];
      if (!best || s.date > best.date)
        best = { date: s.date, key, equipment: s.equipment };
    }
    if (!best) return null;
    const v = variantOf(best.key);
    const name = v
      ? v.equipment
        ? composeVariant(v.group, v.equipment)
        : v.group.name
      : best.key;
    const equipmentId = best.equipment
      ? (equipmentList.find(
          (e) => e.name.toLowerCase() === best!.equipment!.toLowerCase()
        )?.id ?? null)
      : null;
    return { name, equipmentId };
  }
  // The custom implement id used in the most recent session of an exact exercise
  // name, or null.
  function lastEquipmentId(name: string): number | null {
    const eqName = history[name.trim().toLowerCase()]?.sessions[0]?.equipment;
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
  // Custom-part flags for a typed or picked name: a coined (logged,
  // non-curated) cardio/sport name stays custom with its vocabulary type; any
  // other name is un-committed until an explicit "Add as new" pick.
  const customFlags = (name: string): Partial<PartEntry> => {
    const coined = isCoined(name);
    return { custom: coined, customType: coined ? nameType(name) : null };
  };
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
    const comps = namedParts.map((p) => {
      const t = partType(p)!;
      return {
        name: p.name.trim(),
        type: t,
        distance:
          partNeedsDistance(p) && p.distance ? Number(p.distance) : null,
        duration_min:
          t !== "strength" && p.durationMin ? Number(p.durationMin) : null,
      };
    });
    const flat: {
      exercise: string;
      weight: number | null;
      reps: number | null;
      weightRight: number | null;
      repsRight: number | null;
      durationSec: number | null;
      durationSecRight: number | null;
      equipmentId: number | null;
      targetReps: number | null;
      toFailure: boolean;
    }[] = [];
    for (const p of namedParts) {
      if (partType(p) !== "strength") continue;
      const timed = isTimed(p.name);
      const intent = partIntent(p);
      for (const s of p.sets) {
        const perSide = p.perSide;
        // For timed holds the "effort" is duration; otherwise it's reps.
        const hasLeft = sideComplete(p.name, s.weight, s.reps, s.duration);
        const hasRight =
          perSide &&
          sideComplete(p.name, s.weightRight, s.repsRight, s.durationRight);
        if (!hasLeft && !hasRight) continue;
        flat.push({
          exercise: p.name.trim(),
          weight: s.weight ? Number(s.weight) : null,
          reps: timed ? null : s.reps ? Number(s.reps) : null,
          weightRight: hasRight && s.weightRight ? Number(s.weightRight) : null,
          repsRight: timed
            ? null
            : hasRight && s.repsRight
              ? Number(s.repsRight)
              : null,
          durationSec: timed ? parseSeconds(s.duration) : null,
          durationSecRight:
            timed && hasRight ? parseSeconds(s.durationRight) : null,
          equipmentId: p.equipmentId,
          targetReps: intent.target,
          toFailure: intent.toFailure,
        });
      }
    }
    const primaryType =
      comps.find((c) => c.type === "strength")?.type ?? comps[0].type;

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
      }),
    [date, startTime, endTime, intensity, notes, parts, effectiveTitle]
  );
  // The state we last persisted (or loaded). Starts equal to the initial state
  // so loading existing data — or opening a blank create form — saves nothing.
  const savedSigRef = useRef<string>(formSig);
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
      if (
        res &&
        typeof res === "object" &&
        "id" in res &&
        res.id != null &&
        savableId() == null
      ) {
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
      message: `Delete “${editData?.title ?? liveTitle}” (${date})? This can’t be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("id", String(id));
      await deleteActivity(fd);
      // Don't let the unmount flush re-create the row we just deleted.
      savedSigRef.current = formSig;
      createdIdRef.current = null;
      onClose();
      router.refresh();
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

  // Nag when the user has changed something the save can't accept, but also on
  // an untouched existing activity whose loaded data already can't save (e.g.
  // imported rows or records predating stricter validation) — otherwise edits
  // would silently never persist. Only a pristine blank create shows nothing.
  const dirty = formSig !== savedSigRef.current;
  const blocker = (dirty || hasRow) && !canSave ? saveBlocker() : null;

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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-slate-100">
            {headingType && (
              <ActivityIcon
                type={headingType}
                title={firstValid.name}
                className="h-6 w-6 text-brand-600 dark:text-brand-400"
              />
            )}
            {effectiveTitle}
          </h2>
          {/* Date lives in a field below, but surfacing it in the header gives
              at-a-glance context for the row being edited. Reads live `date`
              state, so it tracks edits to the field. */}
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {formatLongDate(date)}
          </p>
        </div>
        {/* Close control for both the centered modal and the docked editor; the
            docked form flushes any pending auto-save on unmount. */}
        {/* Negative margin keeps the icon in place while the hit area grows to
            finger size (same trick on the small controls below). */}
        <button
          type="button"
          onClick={requestClose}
          className="-m-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-300"
          aria-label="Close"
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>

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
                    options={allOptions}
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
                  createdId={createdId}
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

      {/* Date and times */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label">Date</label>
          <DateField value={date} onChange={setDate} required />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0">Start</label>
            {startTime !== nowHHMM(tz) && (
              <button
                type="button"
                onClick={() => setStartTime(nowHHMM(tz))}
                className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                now
              </button>
            )}
          </div>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="input mt-1"
          />
        </div>
        <div>
          <label className="label">End</label>
          <input
            type="time"
            value={endTime}
            min={startTime || undefined}
            onChange={(e) => setEndTime(e.target.value)}
            className={`input ${timeError ? "border-rose-300 dark:border-rose-800" : ""}`}
          />
        </div>
      </div>
      {timeError && (
        <p className="-mt-2 text-xs text-rose-500 dark:text-rose-400">
          End time must be after the start time.
        </p>
      )}
      {!timeError && overallDuration != null && (
        <p className="-mt-2 text-xs text-slate-400 dark:text-slate-500">
          Duration: {overallDuration} min
        </p>
      )}

      {/* Notes (collapsible) */}
      <div>
        <button
          type="button"
          onClick={toggleNotes}
          className="label mb-0 flex items-center gap-1.5 hover:text-slate-700 dark:hover:text-slate-200"
        >
          Notes
          <span className="text-slate-400 dark:text-slate-500">
            {notesOpen ? (
              <IconChevronDown className="h-4 w-4" />
            ) : (
              <IconChevronRight className="h-4 w-4" />
            )}
          </span>
          {!notesOpen && notes.trim() && (
            <span className="normal-case text-slate-400 dark:text-slate-500">
              ({notes.trim().length} chars)
            </span>
          )}
        </button>
        {notesOpen && (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="input mt-1"
            placeholder="How did it feel?"
          />
        )}
      </div>

      {/* Intensity */}
      <div>
        <label className="label">Intensity</label>
        <div className="grid grid-cols-3 gap-2">
          {INTENSITIES.map((opt) => {
            const active = intensity === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setIntensity(active ? "" : opt.value)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  active
                    ? opt.active
                    : `bg-white dark:bg-ink-900 ${opt.cls} hover:bg-slate-50 dark:hover:bg-ink-800`
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

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

      {/* Sticky variant: negative margins re-span the overlay panel's padding
          (p-4 / sm:p-6 in ActivityOverlay) so the bar runs edge to edge; bottom
          offsets match the overlay's outer padding (0 on the mobile full page,
          sm:p-8 around the centered card); the bottom padding clears the home
          indicator on notched phones. */}
      <div
        className={`flex items-center justify-between gap-2 ${
          stickyFooter
            ? "sticky bottom-0 -mx-4 -mb-4 border-t border-black/5 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-bottom-8 sm:-mx-6 sm:-mb-6 sm:rounded-b-xl sm:px-6 dark:border-white/10 dark:bg-ink-900"
            : "pt-2"
        }`}
      >
        <div>
          {hasRow && (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
            >
              Delete
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <SaveStatus
            pending={status === "saving"}
            savedAt={savedAt}
            error={status === "error"}
          />
          {stickyFooter && (
            <button type="button" onClick={requestClose} className="btn">
              Done
            </button>
          )}
        </div>
      </div>

      {plateTarget && (
        <PlateBuilderModal
          unit={units.weightUnit}
          equipment={equipmentList}
          initialBarId={parts[plateTarget.pi]?.equipmentId ?? null}
          initialWeight={
            Number(
              parts[plateTarget.pi]?.sets[plateTarget.si]?.[plateTarget.field]
            ) || 0
          }
          onUse={applyPlateBuild}
          onCreated={(e) => setEquipmentList((prev) => [...prev, e])}
          onClose={() => setPlateTarget(null)}
        />
      )}
    </form>
  );
}
