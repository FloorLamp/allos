// The pace-aware WELLNESS-PRACTICE reminder (issue #1259 phase 2). Coaching-tier and
// BUS-GATED like every calm nudge: it nags ONLY when a practice target is behind its
// weekly floor (the workout-nudge pattern, #221) — quiet when on track, SILENT at/above
// the ceiling (a dose-limited practice is never pushed toward MORE) — and holds a target
// whose `practice:<id>` Upcoming twin is dismissed/snoozed (dismiss once, silence
// everywhere, #227). NEVER safety-tier (a missed red-light session is not a missed
// medication). Each behind practice gets an inline "Done ✓" button that logs a session
// through the shared write core; the button carries ids only and is consumed on tap.
//
// One computation (#221): the behind decision is exactly the Upcoming practiceItems
// filter — getFrequencyTargetProgress (which folds range semantics via frequencyRangeState)
// filtered to practice / !met / !atCeiling / pace "behind". The nudge is a formatter over it.

import { getFrequencyTargetProgress } from "../queries";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import { practiceSignalKey, practiceCadenceText } from "../practice";
import { today as todayFor } from "../db";
import { practiceDoneCallback } from "./callback-data";
import type { NotificationAction, NotificationMessage } from "./types";

// Cap the buttons so the keyboard stays tappable; the rest still reads in the body.
const MAX_PRACTICE_BUTTONS = 4;

// A behind, non-suppressed practice target ready to nudge — the gather the builder
// formats and the (test-visible) decision surface.
export interface BehindPractice {
  targetId: number;
  name: string;
  count: number;
  floor: number;
  ceiling: number | null;
}

// Gather the profile's behind, non-suppressed practice targets (the bus-gated pace
// decision). Exported so the DB-tier builder test can assert the decision directly.
export function behindPractices(profileId: number): BehindPractice[] {
  const suppressions = getFindingSuppressions(profileId);
  const today = todayFor(profileId);
  return getFrequencyTargetProgress(profileId)
    .filter((p) => p.target.scope_kind === "practice")
    .filter((p) => !p.met && !p.atCeiling && p.pace === "behind")
    .filter((p) => {
      // Bus gate: a dismissed/snoozed Upcoming twin holds the push too.
      const rec = suppressions.get(practiceSignalKey(p.target.id));
      return !(rec != null && isSuppressed(rec, today));
    })
    .map((p) => ({
      targetId: p.target.id,
      name: p.target.scope_value,
      count: p.count,
      floor: p.per_week,
      ceiling: p.per_week_max,
    }));
}

// Build the practice reminder, or null when nothing is behind (or all behind targets are
// suppressed). A per-render nonce distinguishes redelivered callbacks; the write core's
// own semantics own the actual double-log guard, and the button is consumed on tap.
export function buildPracticeReminder(
  profileId: number,
  nonce: string = Date.now().toString(36)
): NotificationMessage | null {
  const behind = behindPractices(profileId);
  if (behind.length === 0) return null;

  const lines = behind.map(
    (b) => `• ${b.name} — ${b.count}/${practiceCadenceText(b.floor, b.ceiling)}`
  );
  const actions: NotificationAction[] = behind
    .slice(0, MAX_PRACTICE_BUTTONS)
    .map((b) => ({
      label: `✓ ${b.name}`,
      data: practiceDoneCallback(profileId, b.targetId, nonce),
    }));

  return {
    title: "Practice check-in",
    body:
      behind.length === 1
        ? `You're behind on ${behind[0].name} this week (${behind[0].count}/${practiceCadenceText(behind[0].floor, behind[0].ceiling)}). Tap when you've done a session.`
        : `A few practices are behind this week:\n${lines.join("\n")}\n\nTap when you've done a session.`,
    actions,
    kind: "other",
  };
}
