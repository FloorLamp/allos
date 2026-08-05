import {
  activityComponentSportNames,
  pickActivityIconKey,
} from "./activity-icon";
import { activityHistoryKey } from "./activities-catalog";

export interface CyclingActivityIdentity {
  type: string;
  title: string;
  components: string | null | undefined;
}

export interface CyclingActivityPresentation {
  name: string;
  indoorOnly: boolean;
  noun: "ride" | "session";
  pluralNoun: "rides" | "sessions";
}

const INDOOR_CYCLING =
  /\b(indoor|stationary|spin(?:ning)?|trainer|virtual|peloton|zwift|air bike)\b/i;

export function isCyclingActivityName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    pickActivityIconKey("cardio", trimmed, [trimmed]) === "bike"
  );
}

// The canonical cycling subtype is the structured cardio component when one is
// available (Cycling, Mountain Biking, Stationary Bike, ...). Legacy/manual rows
// fall back to their title, matching the generic Analyze grouping contract.
export function cyclingActivityName(
  activity: CyclingActivityIdentity
): string | null {
  if (activity.type !== "cardio" && activity.type !== "sport") return null;
  const sportNames = activityComponentSportNames(activity.components);
  if (
    pickActivityIconKey(activity.type, activity.title, sportNames) !== "bike"
  ) {
    return null;
  }
  return (
    (sportNames.find((name) => isCyclingActivityName(name)) ??
      activity.title.trim()) ||
    null
  );
}

export function isCyclingActivity(activity: CyclingActivityIdentity): boolean {
  return cyclingActivityName(activity) != null;
}

export function isSameCyclingActivity(
  current: CyclingActivityIdentity,
  candidate: CyclingActivityIdentity
): boolean {
  const currentName = cyclingActivityName(current);
  const candidateName = cyclingActivityName(candidate);
  return (
    currentName != null &&
    candidateName != null &&
    activityHistoryKey(currentName) === activityHistoryKey(candidateName)
  );
}

export function cyclingActivityPresentation(
  name: string
): CyclingActivityPresentation {
  const indoorOnly = INDOOR_CYCLING.test(name.trim());
  return {
    name,
    indoorOnly,
    noun: indoorOnly ? "session" : "ride",
    pluralNoun: indoorOnly ? "sessions" : "rides",
  };
}
