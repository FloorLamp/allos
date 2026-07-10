// Pure validation, title-generation, and save-payload logic for ActivityForm
// (issue #127). No React, no state, no DB: the form keeps rendering + event
// wiring and delegates every decision here, so the rules are unit-testable in
// isolation (see lib/__tests__/activity-form-validate.test.ts). The
// completeness/partial-set primitives are shared with the journal's stored-row
// validator via lib/activity-form-model → lib/activity-validate.

import type { ActivityType } from "./types";
import { variantOf, isTimed, suggestTitle } from "./lifts";
import { isCuratedActivity } from "./activities-catalog";
import { showsDistanceField, timeOfDay, titleCase } from "./activity-meta";
import { isValidDuration, parseSeconds } from "./duration";
import { isRealIsoDate } from "./date";
import {
  setComplete,
  setPartial,
  sideComplete,
  partIntent,
  type PartEntry,
  type PartFault,
} from "./activity-form-model";

// ---- Name classification ----
//
// A part's name determines its type, whether it needs an equipment pick, and
// whether it shows a distance field. All of it derives from the picker's
// vocabulary (a lowercased name → type map built from the profile's
// suggestions) plus the curated lift catalog, so the classifier is a pure
// function of that map. The form builds it once and destructures the members
// it still calls inline; keeping the members' bodies here makes them testable.
export interface NameClassifier {
  nameType(name: string): ActivityType | null;
  isKnown(name: string): boolean;
  isCoined(name: string): boolean;
  partType(p: PartEntry): ActivityType | null;
  partNeedsDistance(p: PartEntry): boolean;
  customFlags(name: string): Partial<PartEntry>;
}

export function makeNameClassifier(
  typeByName: Map<string, ActivityType>
): NameClassifier {
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
  // parts the chip/inferred/stored choice is the only source.
  const partType = (p: PartEntry): ActivityType | null => {
    if (!p.name.trim()) return null;
    return p.custom ? p.customType : nameType(p.name);
  };
  const partNeedsDistance = (p: PartEntry) =>
    showsDistanceField(p.name, partType(p), p.custom);
  // Custom-part flags for a typed or picked name: a coined (logged,
  // non-curated) cardio/sport name stays custom with its vocabulary type; any
  // other name is un-committed until an explicit "Add as new" pick.
  const customFlags = (name: string): Partial<PartEntry> => {
    const coined = isCoined(name);
    return { custom: coined, customType: coined ? nameType(name) : null };
  };
  return {
    nameType,
    isKnown,
    isCoined,
    partType,
    partNeedsDistance,
    customFlags,
  };
}

// A bare variant base ("Curl") still needs an equipment chip picked before it
// is a concrete, savable lift.
export const needsEquipment = (name: string) =>
  variantOf(name)?.equipment === null;

// ---- Form-level validity + auto-save gating ----

export interface ActivityFormState {
  parts: PartEntry[];
  startTime: string;
  endTime: string;
  date: string;
}

export interface ActivityFormAnalysis {
  // Parts the user has actually named (the ones judged + saved).
  namedParts: PartEntry[];
  // End time before start time.
  timeError: boolean;
  // A full start–end range, which can stand in for a cardio/sport duration.
  timeRange: boolean;
  // Every gate passed — the auto-save may fire.
  canSave: boolean;
  // The trailing part is complete enough to add another below it.
  canAddPart: boolean;
  // The one-line reason auto-save is paused, in canSave-clause order, or null.
  saveBlocker: string | null;
  // Per-part fault for flagging its card + inputs (null when the part is fine).
  partFault: (p: PartEntry) => PartFault;
}

export function analyzeActivityForm(
  classifier: NameClassifier,
  state: ActivityFormState
): ActivityFormAnalysis {
  const { partType, partNeedsDistance, isKnown } = classifier;
  const { parts, startTime, endTime, date } = state;

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
  const timeRange = !!startTime && !!endTime && !timeError;
  // Only a distance the save will actually keep counts as content — a value
  // stranded in state after its field hid must pause the save.
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

  // Per-part fault (only for parts the user has named): the reason this activity
  // can't be saved, so its card can be flagged. `null` when the part is fine.
  const partFault = (p: PartEntry): PartFault => {
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
  // same order as canSave's clauses. `null` when the form is savable. Kept in
  // sync with lib/activity-validate's storedActivityFault.
  const saveBlocker = (): string | null => {
    if (canSave) return null;
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
      const empty = namedParts.find((p) => !partHasContent(p));
      return empty && partType(empty) === "strength"
        ? "Enter a set — weight & reps, or a hold time."
        : "Enter a distance, duration, or a start & end time.";
    }
    return null;
  };

  return {
    namedParts,
    timeError,
    timeRange,
    canSave,
    canAddPart,
    saveBlocker: saveBlocker(),
    partFault,
  };
}

// The auto-generated activity name from its named parts and start time: a
// strength title (via suggestTitle) optionally combined with duration-prefixed
// cardio/sport names, prefixed with the time-of-day greeting.
export function generateActivityTitle(
  startTime: string,
  namedParts: PartEntry[],
  classifier: NameClassifier
): string {
  const { partType } = classifier;
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

// ---- Save payload shaping ----

export interface ActivityComponentPayload {
  name: string;
  type: ActivityType;
  distance: number | null;
  duration_min: number | null;
}

export interface ActivitySetPayload {
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
}

export interface ActivityPayload {
  comps: ActivityComponentPayload[];
  flat: ActivitySetPayload[];
  primaryType: ActivityType;
}

// The component list, flattened set rows, and primary type saveActivity expects,
// derived from the named parts. Numbers are left in the user's display unit
// (the server action converts to canonical kg/km). Callers gate on canSave
// first, so namedParts is non-empty and every part has a resolved type.
export function buildActivityPayload(
  classifier: NameClassifier,
  namedParts: PartEntry[]
): ActivityPayload {
  const { partType, partNeedsDistance } = classifier;
  const comps: ActivityComponentPayload[] = namedParts.map((p) => {
    const t = partType(p)!;
    return {
      name: p.name.trim(),
      type: t,
      distance: partNeedsDistance(p) && p.distance ? Number(p.distance) : null,
      duration_min:
        t !== "strength" && p.durationMin ? Number(p.durationMin) : null,
    };
  });
  const flat: ActivitySetPayload[] = [];
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
  return { comps, flat, primaryType };
}
