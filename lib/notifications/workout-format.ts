// Pure formatting for the Telegram workout reminder (#221) — no DB/network, so it
// stays unit-testable and shares the exact next-workout result the dashboard and
// Training overview render. The DB-reading gather + core call live in
// ./recommend (recommendWorkout); ./workouts wires the two together.

import { suggestTitle, type MuscleRegion } from "../lifts";
import type { NotificationMessage } from "./types";

export interface WorkoutRecommendation {
  focus: MuscleRegion[];
  exercises: string[];
  behind: string[]; // behind-target labels, for message context
  // Recovery/celebration awareness carried from the unified coaching engine (#221),
  // so the reminder can note a rest day or an on-track week instead of blindly
  // pushing a workout. Null when the top-line recommendation isn't rest/on-track.
  rest: { title: string; detail: string } | null;
  onTrack: { title: string; detail: string } | null;
}

// Render a WorkoutRecommendation as the Telegram message. Split out from the
// DB-reading path so the cross-surface consistency test can drive it with the
// same next-workout result the dashboard/overview render.
export function formatWorkoutReminder(
  rec: WorkoutRecommendation | null
): NotificationMessage | null {
  if (!rec) return null;

  const focusLabel = rec.exercises.length
    ? suggestTitle(rec.exercises) // "Push day" / "Chest workout" / "Full body workout"
    : rec.focus.join(" / ");

  // Recovery override: a rest day reframes the nudge; the workout suggestion, if
  // any, becomes a "when you're ready" footnote rather than the headline.
  if (rec.rest) {
    const lines: string[] = [rec.rest.detail];
    if (rec.exercises.length)
      lines.push(`When you're ready: ${rec.exercises.join(", ")}`);
    else if (rec.focus.length)
      lines.push(`When you're ready: ${rec.focus.join(", ")}`);
    return {
      title: `🛌 ${rec.rest.title}`,
      body: lines.join("\n"),
      kind: "workout",
    };
  }

  const lines: string[] = [];
  if (rec.exercises.length)
    lines.push(`Suggested: ${rec.exercises.join(", ")}`);
  else if (rec.focus.length) lines.push(`Focus: ${rec.focus.join(", ")}`);
  if (rec.onTrack) lines.push(rec.onTrack.detail);
  if (rec.behind.length)
    lines.push(`Behind this week: ${rec.behind.join(", ")}`);

  return {
    title: rec.onTrack
      ? `✅ ${rec.onTrack.title}`
      : focusLabel
        ? `🏋️ Today's workout — ${focusLabel}`
        : "🏋️ Today's workout",
    body: lines.join("\n"),
    kind: "workout",
  };
}
