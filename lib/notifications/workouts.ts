// Builds the workout reminder: a recommended session for today, derived from the
// user's usual weekday schedule + weekly targets they're behind on, avoiding the
// muscle region trained yesterday. Returns null when there's nothing to suggest.

import { suggestTitle } from "../lifts";
import { recommendWorkout } from "./recommend";
import type { NotificationMessage } from "./types";

export function buildWorkoutTargetReminder(
  profileId: number
): NotificationMessage | null {
  const rec = recommendWorkout(profileId);
  if (!rec) return null;

  const focusLabel = rec.exercises.length
    ? suggestTitle(rec.exercises) // "Push day" / "Chest workout" / "Full body workout"
    : rec.focus.join(" / ");

  const lines: string[] = [];
  if (rec.exercises.length)
    lines.push(`Suggested: ${rec.exercises.join(", ")}`);
  else if (rec.focus.length) lines.push(`Focus: ${rec.focus.join(", ")}`);
  if (rec.behind.length)
    lines.push(`Behind this week: ${rec.behind.join(", ")}`);

  return {
    title: focusLabel
      ? `🏋️ Today's workout — ${focusLabel}`
      : "🏋️ Today's workout",
    body: lines.join("\n"),
  };
}
