"use client";

import LogPracticeButton from "@/components/practices/LogPracticeButton";
import PracticeWeeklyProgress from "@/components/practices/PracticeWeeklyProgress";
import PracticeEditor from "@/app/(app)/wellness/PracticeEditor";
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
  today,
  onDone,
}: {
  practices: TrackedPractice[];
  // The acting profile's today (YYYY-MM-DD) — the day the counts are counting, and
  // the day the re-log question is asked about (#2007 layer 3).
  today: string;
  // Dismisses the sheet. Used ONLY by the zero-state create branch below — the
  // logging branch deliberately stays open (see the paragraph above).
  onDone?: () => void;
}) {
  // ZERO STATE: the first practice is offered here (#3066). The /wellness nav row is
  // hidden until practice state exists (#1620, correct), and every other door onto
  // practices — the palette sheet, the Telegram nudges, the habits widget, the trends
  // lens (and the frequent-pages row, until #4102 retired it) — also requires an
  // existing practice. This sheet row
  // is always visible, so it is where the bootstrap belongs.
  //
  // It mounts the SAME PracticeEditor the Wellness page's Add button mounts, over the
  // same `savePractice` action — no second create path, and nothing here to drift.
  // Inline rather than behind the page's modal trigger: stacking a dialog over this
  // sheet is not what a one-tap surface is for.
  //
  // UNLIKE the logging branch, this one CLOSES on success. Declaring a practice is a
  // transaction with a real end, and the sheet's props were gathered on open — so
  // staying would show the create form again over a list that has since changed.
  // Reopening "Log practice" now finds the practice, and the nav row has appeared.
  if (practices.length === 0) {
    return (
      <div className="space-y-3" data-testid="quick-entry-practice-empty">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing tracked yet. Start a practice and log it from here.
        </p>
        <PracticeEditor compact onDone={onDone} />
      </div>
    );
  }

  return (
    <ul data-testid="quick-entry-practice-list" className="flex flex-col gap-2">
      {practices.map((practice) => (
        <li
          key={practice.identity}
          data-testid={`quick-entry-practice-${practice.identity}`}
          className="rounded-lg border border-(--border) bg-surface px-3 py-2.5"
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
                surface is for; the Wellness card keeps that path.

                `inlineDuration` is the OTHER answer to the same objection (#2204). "20
                min sauna" vs "5 min" is most of what a practice log means, and the one
                surface that promised the fastest way to record one was the surface that
                threw it away. The stepper arrives already holding this practice's last
                logged duration, so accepting it costs nothing and the tap is still one
                tap; it is a control, not a form, and it opens nothing. */}
            <LogPracticeButton
              practice={practice.name}
              todayCount={practice.todayCount}
              today={today}
              defaultDurationMin={practice.previousDurationMin}
              liveSession={practice.liveSession}
              inlineDuration
              inlineWhen
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
