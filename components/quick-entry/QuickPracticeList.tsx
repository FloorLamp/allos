"use client";

import LogPracticeButton from "@/components/practices/LogPracticeButton";
import PracticeWeeklyProgress from "@/components/practices/PracticeWeeklyProgress";
import type { TrackedPractice } from "@/lib/queries/wellness";

// The quick-entry overlay's PRACTICE form (issue #1633): every tracked wellness
// practice, each one tap from logging today's session.
//
// The gap this closes is embarrassing rather than subtle — the Telegram bot has had
// one-tap practice logging since #1259, while the web app's fastest route to the
// wellness domain's core action was: open the drawer, find Wellness (itself
// relevance-gated), scroll to the card, tap. The sheet already promises "log from
// anywhere"; this is the row that makes that true for practices.
//
// It is a LIST, not a form. Each row mounts the SAME `LogPracticeButton` the Wellness
// card mounts — which posts the SAME `logPractice` Server Action over the SAME
// `logPracticeSession` write core, answers from its typed `PracticeLogOutcome`, and
// shows today's running count beside the tap so a deliberate second session is informed
// rather than accidental. Nothing here logs a session itself, and there is no overlay
// copy of the control to drift from the card's.
//
// **The sheet stays open after a tap**, deliberately — unlike the dose list, which
// closes once nothing is left to confirm. A practice session is not a queue being
// drained: a morning check may log a sauna AND a meditation, multi-session days are the
// point (#797's ledger model), and the button refreshes the page behind it, so "stay
// where you were" already holds. There is no moment where the overlay can honestly say
// the user is done.
export default function QuickPracticeList({
  practices,
}: {
  practices: TrackedPractice[];
}) {
  return (
    <ul data-testid="quick-entry-practice-list" className="flex flex-col gap-2">
      {practices.map((practice) => (
        <li
          key={practice.identity}
          data-testid={`quick-entry-practice-${practice.identity}`}
          className="rounded-lg border border-black/10 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-ink-900"
        >
          <PracticeWeeklyProgress
            label={practice.name}
            count={practice.countThisWeek}
            perWeek={practice.perWeek}
            perWeekMax={practice.perWeekMax}
            pace={practice.pace}
            atCeiling={practice.atCeiling}
          />
          <div className="mt-2">
            {/* The ceiling is a WEEK fact and the line above already states it, so it
                is deliberately not repeated on the button's today line — one row, one
                "that's plenty". No `showDetails`: the expanded date/time/duration form
                is a modal, and stacking one over this sheet is not what a one-tap
                surface is for; the Wellness card keeps that path. */}
            <LogPracticeButton
              practice={practice.name}
              todayCount={practice.todayCount}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
