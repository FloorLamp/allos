// Pure formatting for the Telegram workout reminder (#221) — no DB/network, so it
// stays unit-testable and shares the exact next-workout result the dashboard and
// Training overview render. The DB-reading gather + core call live in
// ./recommend (recommendWorkout); ./workouts wires the two together.

import { suggestTitle, type MuscleRegion } from "../lifts";
import { frequencyScopeLabel } from "../goals";
import {
  workoutAcknowledgmentLine,
  type BehindTargetPace,
} from "../effort-class";
import type { OrderedBehindTarget } from "../workout-recommendation";
import type { NotificationAction, NotificationMessage } from "./types";
import { bold, joinBody, richFrom, type MessageBody } from "./rich-text";

export interface WorkoutRecommendation {
  focus: MuscleRegion[];
  exercises: string[];
  // The behind weekly targets, ALREADY ordered and marked by the pure core (#1709):
  // the target that drove today's suggestion leads, the rest follow by deficit. Kept
  // structured to here so the formatter can relate the list to the recommendation —
  // flattening it upstream is exactly what disconnected the two halves.
  behind: OrderedBehindTarget[];
  // Recovery/celebration awareness carried from the unified coaching engine (#221),
  // so the reminder can note a rest day or an on-track week instead of blindly
  // pushing a workout. Null when the top-line recommendation isn't rest/on-track.
  // `also` carries any CONCURRENT under-recovery signals (#1148) — the same set the
  // dashboard card shows — so the nudge names every firing reason, not just the top.
  rest: { title: string; detail: string; also?: string[] } | null;
  onTrack: { title: string; detail: string } | null;
  // Today's routine day label (#740), when an active routine resolved a session
  // ("Push", "Pull", …). Titles the nudge ("🏋️ Push day: …") so the reminder names
  // the actual sequence day. Null / absent ⇒ the prior habit-derived title.
  sessionLabel?: string | null;
  // The routine's mesocycle says today is a deload week (#741). The nudge KEEPS
  // firing (it isn't suppressed) but SOFTENS: it names the deload so a lighter
  // session reads as on-plan, not as falling behind. Absent / false ⇒ no note.
  deloadWeek?: boolean;
  // The same-day acknowledgment (#1672): what was already trained today, and the pace
  // fact that justifies pushing anyway. Present ONLY when the nudge is firing on a
  // trained day — on every other day the message is unchanged.
  acknowledge?: {
    session: string;
    forcedBy: BehindTargetPace | null;
  } | null;
  // The tight-week recovery override (#1673): today's suggestion asks for a region that
  // is still inside its recovery window, because the week can no longer be met without
  // it. The line states BOTH facts ("Back was Saturday — 1/2 with today left."), so the
  // nudge never reads as having forgotten Saturday's session. Absent on every ordinary
  // day (loose weeks yield the rest reframe instead).
  recoveryOverride?: string | null;
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

  // Deload-week softening (#741): the nudge still fires, but names the deload so a
  // lighter week reads as on-plan rather than as falling behind.
  const deloadNote = rec.deloadWeek
    ? "Deload week — keep it light and let fatigue clear."
    : null;

  // Recovery override: a rest day reframes the nudge; the workout suggestion, if
  // any, becomes a "when you're ready" footnote rather than the headline.
  if (rec.rest) {
    const lines: string[] = [rec.rest.detail];
    // Concurrent under-recovery signals (#1148): name the rest so a snooze can't bury
    // a signal the user never saw — the same "Also: …" line the dashboard card shows.
    if (rec.rest.also?.length) lines.push(`Also: ${rec.rest.also.join("; ")}.`);
    if (deloadNote) lines.push(deloadNote);
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
  // LEAD WITH WHAT THEY DID (#1672, the workout-presence copy standard): when the nudge
  // fires on a day that already saw a session, the message opens with it. Without this
  // the push read as "the app didn't notice my workout".
  const ackLine = workoutAcknowledgmentLine(rec.acknowledge ?? null);
  if (ackLine) lines.push(ackLine);
  // Same posture one step out (#1673 decision 4): when pace overrides a region's
  // recovery window, say what was trained and why today still counts.
  if (rec.recoveryOverride) lines.push(rec.recoveryOverride);
  if (deloadNote) lines.push(deloadNote);
  if (rec.exercises.length)
    lines.push(`Suggested: ${rec.exercises.join(", ")}`);
  else if (rec.focus.length) lines.push(`Focus: ${rec.focus.join(", ")}`);
  if (rec.onTrack) lines.push(rec.onTrack.detail);
  const behindLine = behindThisWeekLine(rec.behind);

  return {
    title: rec.onTrack
      ? `✅ ${rec.onTrack.title}`
      : focusLabel
        ? `🏋️ Today's workout — ${focusLabel}`
        : "🏋️ Today's workout",
    body: joinBody([lines.join("\n"), behindLine], "\n"),
    kind: "workout",
    ...(guideActions.length ? { actions: guideActions } : {}),
  };
}

// The marker on the target that drove today's suggestion (#1709). BOTH forms, by
// owner decision: the `← today` suffix always (it renders identically on every channel
// and reads naturally in-app) plus bold where markup is supported, degrading cleanly to
// the suffix alone on Web Push / Home Assistant.
export const BEHIND_DRIVER_SUFFIX = " ← today";

// "Back 0/2 ← today, Chest 1/2, Lower body 1/2, Cardio 1/2" — the list in the order the
// core decided, with the driving target marked. Null when nothing is behind.
export function behindThisWeekLine(
  behind: readonly OrderedBehindTarget[]
): MessageBody | null {
  if (behind.length === 0) return null;
  const parts: (string | ReturnType<typeof bold>)[] = ["Behind this week: "];
  behind.forEach((t, i) => {
    if (i > 0) parts.push(", ");
    const label = `${frequencyScopeLabel(t.scopeKind, t.scopeValue)} ${t.count}/${t.perWeek}`;
    parts.push(t.driving ? bold(`${label}${BEHIND_DRIVER_SUFFIX}`) : label);
  });
  return richFrom(parts);
}

// The digest's ONE-LINE workout preview (#1712 §2). Formatted from the SAME
// WorkoutRecommendation the dedicated nudge renders, so a 7am heads-up and the
// actionable prompt later cannot disagree — they format one computation (#221).
//
// Rest and on-track states REFRAME the line exactly as they reframe the nudge (never a
// blind "train today" on a rest day), and a recommendation with nothing to say yields
// null so the digest simply omits the line.
export function digestWorkoutLine(
  rec: WorkoutRecommendation | null
): string | null {
  if (!rec) return null;
  if (rec.rest) return `🛌 Today: ${rec.rest.title}`;
  if (rec.onTrack) return `✅ Today: ${rec.onTrack.title}`;
  // suggestTitle falls back to a generic "Strength session" for an empty focus, which
  // is fine for the nudge's TITLE but would put a contentless line in the digest — so
  // the preview asks for a real focus or a resolved routine day before naming one.
  const head =
    rec.sessionLabel ?? (rec.focus.length ? suggestTitle(rec.focus) : null);
  const exercises = rec.exercises.slice(0, 3).join(", ");
  if (!head && !exercises) return null;
  const deload = rec.deloadWeek ? " (deload week)" : "";
  return exercises
    ? `🏋️ Today: ${head ? `${head} — ` : ""}${exercises}${deload}`
    : `🏋️ Today: ${head}${deload}`;
}
