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
//
// RHYTHM RETIMING (#2188): when a behind practice has an inferred weekly rhythm
// (inferPracticeSchedule — the workout-schedule shape over practice_logs), the
// nudge additionally WAITS for the practice's next predicted day and typical hour
// instead of firing at the first waking tick of the flip day. The decision is the
// pure practiceNudgeReleased (lib/practice.ts); the tick passes the moment via
// `timing`. Predicted ≠ due (#1505): retiming only ever DELAYS a send the pace
// ledger already justified — a caller that passes no timing (manual mode, the
// legacy tests) gets the untimed gather unchanged, and a practice with no pattern
// behaves byte-for-byte like today under either call shape. The bus gate, the
// per-day marker (owned by the tick) and the ceiling silence are untouched.

import { getFrequencyTargetProgress, inferPracticeSchedule } from "../queries";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  practiceSignalKey,
  practiceCadenceText,
  practiceNudgeReleased,
  practiceRhythmDaysText,
} from "../practice";
import { today as todayFor } from "../db";
import { collectRightSizeCandidates } from "../rule-findings";
import { practiceDoneCallback, rightSizeLowerCallback } from "./callback-data";
import { PRACTICES_HREF } from "../hrefs";
import type { NotificationAction, NotificationMessage } from "./types";

// Cap the buttons so the keyboard stays tappable; the rest still reads in the body.
const MAX_PRACTICE_BUTTONS = 4;

// The tick's moment, threaded into the gather so each behind practice's rhythm can
// hold it for a predicted day (#2188). The week half of the moment
// (daysLeftInWindow) comes from each target's own progress row, not from here.
export interface PracticeNudgeTiming {
  weekday: number; // profile-local today, 0=Sun … 6=Sat
  minuteOfDay: number; // profile-local minute of day
  wakingStartHour: number;
  wakingEndHour: number;
}

// A behind, non-suppressed practice target ready to nudge — the gather the builder
// formats and the (test-visible) decision surface.
export interface BehindPractice {
  targetId: number;
  name: string;
  count: number;
  floor: number;
  ceiling: number | null;
  // The practice's inferred rhythm days for the "usually Mon/Wed/Fri" line —
  // null when no pattern exists (#558: the line then says nothing about days).
  rhythmDays?: number[] | null;
}

// Gather the profile's behind, non-suppressed practice targets (the bus-gated pace
// decision), rhythm-retimed when `timing` is supplied (#2188). Exported so the
// DB-tier builder test can assert the decision directly.
export function behindPractices(
  profileId: number,
  timing?: PracticeNudgeTiming
): BehindPractice[] {
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
    .map((p) => {
      const rhythm = inferPracticeSchedule(profileId, p.target.scope_value);
      return {
        item: {
          targetId: p.target.id,
          name: p.target.scope_value,
          count: p.count,
          floor: p.per_week,
          ceiling: p.per_week_max,
          rhythmDays: rhythm.hasPattern ? rhythm.weekdays : null,
        },
        // Rhythm retiming, per practice: released now, or held for a predicted
        // day later this week. Without a timing (manual mode) nothing is held.
        released:
          timing == null ||
          practiceNudgeReleased(rhythm, {
            ...timing,
            daysLeftInWindow: p.daysLeftInWindow,
          }),
      };
    })
    .filter((entry) => entry.released)
    .map((entry) => entry.item);
}

// One practice's shortfall as a VERDICT rather than a bare ratio (#1722 item 5b) —
// the workout recap's shape: the numbers, then what they mean. "Meditation — 2 of 3
// this week, one more to go." Silent about the next step when the remainder isn't a
// simple count (a range target's ceiling is the calm "that's plenty" case, which the
// gather has already excluded). When a rhythm exists the line also NAMES it
// ("usually Mon/Wed/Fri") — data, not advice (#2188); no pattern names nothing.
export function practiceShortfallLine(b: BehindPractice): string {
  const remaining = Math.max(0, b.floor - b.count);
  const next =
    remaining === 1
      ? ", one more to go"
      : remaining > 1
        ? `, ${remaining} more to go`
        : "";
  // The FLOOR is the number the shortfall is measured against; a range target's
  // ceiling is the calm "that's plenty" case the gather has already excluded, so
  // naming it here would read as a second, competing goal.
  const rhythm =
    b.rhythmDays != null && b.rhythmDays.length > 0
      ? ` (${practiceRhythmDaysText(b.rhythmDays)})`
      : "";
  return `${b.name} — ${b.count} of ${b.floor} this week${next}${rhythm}`;
}

// Build the practice reminder, or null when nothing is behind (or all behind targets are
// suppressed, or — under a supplied `timing` — every behind target's rhythm is holding
// for a predicted day, #2188). A per-render nonce distinguishes redelivered callbacks;
// the write core's own semantics own the actual double-log guard, and the button is
// consumed on tap.
export function buildPracticeReminder(
  profileId: number,
  nonce: string = Date.now().toString(36),
  deepLinkBase = "",
  timing?: PracticeNudgeTiming
): NotificationMessage | null {
  const behind = behindPractices(profileId, timing);
  if (behind.length === 0) return null;

  // RIGHT-SIZING RIDE-ALONG (#1670). A practice whose shortfall has been chronic —
  // every one of the last four completed weeks under the floor — gets one extra button
  // on the message this nudge was already sending, offering the cadence actually kept.
  // No message exists because of a suggestion; this only decorates one that fires for
  // its own reasons (the ride-the-nag rule).
  //
  // Deliberately NOT bus-gated, unlike the nudge itself: an in-app dismiss means "keep
  // asking me about this practice", which is a statement about the CARD, not about
  // whether the offer to shrink the commitment should exist on a message that is being
  // sent anyway. The button is governed by detection state alone (#1505's posture).
  const rightSizeFloor = new Map<number, number>();
  for (const c of collectRightSizeCandidates(profileId, todayFor(profileId)))
    if (c.domain === "practice" && c.suggestedFloor != null)
      rightSizeFloor.set(c.targetId, c.suggestedFloor);

  // Per-item lines adopt the recap's VERDICT shape (#1722 item 5b): numbers, then
  // what they mean and what's next — never a bare ratio. Silent about the next step
  // when there is nothing true to say.
  const lines = behind.map((b) => `• ${practiceShortfallLine(b)}`);
  const actions: NotificationAction[] = [];
  for (const b of behind.slice(0, MAX_PRACTICE_BUTTONS)) {
    actions.push({
      label: `✓ ${b.name}`,
      data: practiceDoneCallback(profileId, b.targetId, nonce),
    });
    const floor = rightSizeFloor.get(b.targetId);
    if (floor != null)
      actions.push({
        label: `⤓ ${b.name} → ${floor}×/wk`,
        data: rightSizeLowerCallback(profileId, b.targetId),
      });
  }
  // A deep link so the message works on EVERY channel (#1718). Web Push and Home
  // Assistant strip the "✓ Done" buttons, and the old body then told those users to
  // "tap when you've done a session" — an instruction to tap nothing. The link is the
  // affordance that survives everywhere; the line that named the buttons is gone,
  // because on Telegram it merely restated the adjacent `✓ Meditation` button.
  const base = deepLinkBase.replace(/\/$/, "");
  if (base) {
    actions.push({
      label: "Open practices →",
      url: `${base}${PRACTICES_HREF}`,
    });
  }

  // OVERFLOW DISCLOSURE (#1722 item 5a). Past the button cap the extra practices were
  // listed in the body with no way to act and no disclosure that buttons had been
  // dropped. The transport's own overflow phrasing, applied at the builder level where
  // the drop actually happens.
  const dropped = Math.max(0, behind.length - MAX_PRACTICE_BUTTONS);
  const overflowNote =
    dropped > 0
      ? `\n⚠️ +${dropped} more — open the app to act on the rest.`
      : "";

  return {
    title: "🧘 Practice check-in",
    body:
      behind.length === 1
        ? `${practiceShortfallLine(behind[0])}${overflowNote}`
        : `A few practices are behind this week:\n${lines.join("\n")}${overflowNote}`,
    actions,
    kind: "practice",
  };
}
