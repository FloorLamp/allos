// Frequency-target vocabulary and pure helpers (#2480).
//
// A frequency target asks how often something should happen in a week. It is
// deliberately separate from outcome goals (`lib/outcome-goals.ts`) and imported
// clinical care goals (`care_goals`): those are different questions with
// different storage, lifecycle, and progress semantics.

import { foodGroupName } from "./food-groups";
import type { FrequencyTarget } from "./types/training";

const GROUP_LABELS: Record<string, string> = {
  Upper: "Upper body",
  Lower: "Lower body",
  Core: "Core",
  Full: "Full body",
};

export type FrequencyPace = "met" | "on-pace" | "behind";

export function frequencyPace(
  count: number,
  perWeek: number,
  elapsedDays: number
): FrequencyPace {
  if (perWeek <= 0 || count >= perWeek) return "met";
  const elapsed = Math.min(7, Math.max(1, Math.trunc(elapsedDays)));
  const owedSoFar = Math.floor((perWeek * elapsed) / 7);
  return count >= owedSoFar ? "on-pace" : "behind";
}

export const WEEKLY_PACE_MAX_NAMED = 3;

export function weeklyTargetPaceLine(
  entries: readonly { label: string; pace: FrequencyPace }[],
  noun = "training target"
): string | null {
  if (entries.length === 0) return null;
  const behind = entries.filter((entry) => entry.pace === "behind");
  const onPace = entries.length - behind.length;
  const head = `${onPace} of ${entries.length} ${noun}${entries.length === 1 ? "" : "s"} on pace`;
  if (behind.length === 0) return head;
  const named = behind
    .slice(0, WEEKLY_PACE_MAX_NAMED)
    .map((entry) => entry.label);
  const rest = behind.length - named.length;
  const tail =
    rest > 0 ? `${named.join(", ")}, +${rest} more` : named.join(", ");
  return `${head} — behind on ${tail}`;
}

export function frequencyPaceLabel(pace: FrequencyPace): string {
  return pace === "met"
    ? "On track"
    : pace === "on-pace"
      ? "On pace"
      : "Behind";
}

export const FREQUENCY_SCOPE_KINDS = [
  "region",
  "group",
  "type",
  "food_group",
  "mobility_region",
  "substance",
  "practice",
] as const;

export type FrequencyScopeKind = (typeof FREQUENCY_SCOPE_KINDS)[number];

export function isFrequencyScope(
  target: Pick<FrequencyTarget, "scope_kind" | "scope_value">,
  kind: FrequencyScopeKind,
  value: string
): boolean {
  return target.scope_kind === kind && target.scope_value === value;
}

// Strength-programming targets are the strength-only subset of Training's broader
// cadence home. Centralized so life-stage gates never re-invent the scope list on a
// page or notification surface.
export function isStrengthProgrammingScope(target: {
  scope_kind: string;
  scope_value: string;
}): boolean {
  return (
    target.scope_kind === "region" ||
    target.scope_kind === "group" ||
    (target.scope_kind === "type" && target.scope_value === "strength")
  );
}

// Targets owned by the workout product rather than Nutrition or Wellness.
// `substance` remains in Training's cadence home today, so it follows that
// surface's relevance policy as well.
export function isTrainingFrequencyScope(target: {
  scope_kind: string;
}): boolean {
  return target.scope_kind !== "food_group" && target.scope_kind !== "practice";
}

export function frequencyScopeLabel(kind: string, value: string): string {
  if (!value) return value;
  if (kind === "group") return GROUP_LABELS[value] ?? value;
  if (kind === "type") return value[0].toUpperCase() + value.slice(1);
  if (kind === "food_group") return foodGroupName(value);
  if (kind === "mobility_region") return `Mobility: ${value}`;
  if (kind === "substance")
    return `${value[0].toUpperCase() + value.slice(1)} (weekly cap)`;
  return value;
}
