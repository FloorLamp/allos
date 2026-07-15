// Pure formatting for the Telegram workout reminder (#221) — no DB/network, so it
// stays unit-testable and shares the exact next-workout result the dashboard and
// Training overview render. The DB-reading gather + core call live in
// ./recommend (recommendWorkout); ./workouts wires the two together.

import { suggestTitle, type MuscleRegion } from "../lifts";
import type { NotificationAction, NotificationMessage } from "./types";

export interface WorkoutRecommendation {
  focus: MuscleRegion[];
  exercises: string[];
  behind: string[]; // behind-target labels, for message context
  // Recovery/celebration awareness carried from the unified coaching engine (#221),
  // so the reminder can note a rest day or an on-track week instead of blindly
  // pushing a workout. Null when the top-line recommendation isn't rest/on-track.
  rest: { title: string; detail: string } | null;
  onTrack: { title: string; detail: string } | null;
  // Today's routine day label (#740), when an active routine resolved a session
  // ("Push", "Pull", …). Titles the nudge ("🏋️ Push day: …") so the reminder names
  // the actual sequence day. Null / absent ⇒ the prior habit-derived title.
  sessionLabel?: string | null;
}

// Render a WorkoutRecommendation as the Telegram message. Split out from the
// DB-reading path so the cross-surface consistency test can drive it with the
// same next-workout result the dashboard/overview render.
//
// `deepLinkBase` (the instance's public URL) enables the "How to" deep-link
// button to the lead exercise's detail panel (#734). Two-way principle: it's a
// URL button — it carries the exercise NAME and deep-links, never a mutation.
// Empty base (unset public URL / unit tests) ⇒ no button.
export function formatWorkoutReminder(
  rec: WorkoutRecommendation | null,
  deepLinkBase = ""
): NotificationMessage | null {
  if (!rec) return null;

  // An active routine names the day explicitly ("Push"); otherwise fall back to the
  // habit-derived title from the exercise list.
  const focusLabel = rec.sessionLabel
    ? `${rec.sessionLabel} day`
    : rec.exercises.length
      ? suggestTitle(rec.exercises) // "Push day" / "Chest workout" / "Full body workout"
      : rec.focus.join(" / ");

  // The lead exercise's how-to guide, as a deep-link button to the Analyze panel
  // (#734). Only when a public URL is configured and a lead lift exists.
  const base = deepLinkBase.replace(/\/$/, "");
  const primary = rec.exercises[0];
  const guideActions: NotificationAction[] =
    base && primary
      ? [
          {
            label: `📖 How to: ${primary}`,
            url: `${base}/training?tab=analyze&kind=strength&exercise=${encodeURIComponent(
              primary
            )}`,
          },
        ]
      : [];

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
      ...(guideActions.length ? { actions: guideActions } : {}),
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
    ...(guideActions.length ? { actions: guideActions } : {}),
  };
}
