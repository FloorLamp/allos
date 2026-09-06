"use client";

import { useCallback, useEffect, useState } from "react";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import PracticeEditor from "@/app/(app)/wellness/PracticeEditor";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { practiceRowFacts, practiceRunningFacts } from "@/lib/practice";
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
// `logPracticeSession` write core and answers from its typed `PracticeLogOutcome`.
// Nothing here logs a session itself, and there is no overlay copy of the control to
// drift from the card's.
//
// ── THE ROW, AND THE THREE THINGS IT CAN SAY (#5431) ────────────────────────
//
// `label · facts · one trailing slot`, in ONE hairline frame rather than a bordered
// card per practice — the shape #5237 and #5300 are moving the dose and substance
// overlays to. Three states, and the facts column is what distinguishes them:
//
//   Red light therapy   0 of 3–5 this week            [15 min · Start] [Just finished]
//   Red light therapy   Running since 06:22 · ends ~06:37                       [End]
//   Red light therapy   1 today · 1 of 3–5 this week  [15 min · Start] [Just finished]
//
// The sheet used to mount the Wellness card's full control here — the `Today` label,
// its "No sessions yet" zero line, and the weekly badge that printed a pace over an
// empty week (#5395) — boxed, with a four-control cluster that wrapped to two lines on
// a phone. Today's count is a fact only when it is not zero.
//
// **The sheet stays open after a tap**, deliberately — unlike the dose list, which
// closes once nothing is left to confirm. A practice session is not a queue being
// drained: a morning check may log a sauna AND a meditation, multi-session days are the
// point (#797's ledger model), and the button refreshes the page behind it, so "stay
// where you were" already holds. There is no moment where the overlay can honestly say
// the user is done.
//
// ── WHY THIS LIST RE-READS THE SERVER ───────────────────────────────────────
//
// A live practice row COMPLETES ITSELF at start plus its usual duration (#5091), with
// no tap and no request. The sheet's props were gathered when it opened, so a row that
// simply sat there went on offering an End the server would answer "that session is no
// longer running" — the sheet's half of the same defect the control's client-only
// session copy was the other half of.
//
// So the list holds the rows and asks for them again: after every write the control
// makes, and on a timer to the derived end the server itself acts on. `loadQuickEntry`
// is THE READ THE MOUNT DID — the same gather, abandonment sweep included — rather than
// a second opinion assembled here.

// A second past the derived end, so the read lands after the instant the server's own
// completion compares against rather than racing it.
const RE_READ_SLACK_MS = 1_000;

export default function QuickPracticeList({
  practices,
  today,
  onDone,
  subjectProfileId,
}: {
  practices: TrackedPractice[];
  // The acting profile's today (YYYY-MM-DD) — the day the counts are counting, and
  // the day the re-log question is asked about (#2007 layer 3).
  today: string;
  // Dismisses the sheet. Used ONLY by the zero-state create branch below — the
  // logging branch deliberately stays open (see the paragraph above).
  onDone?: () => void;
  // The quick-log sheet's chosen subject (#4932), when it is not the acting profile.
  // The gather (`loadQuickEntry`) refuses the zero-state create for a non-acting
  // subject, so this is only ever passed alongside a non-empty `practices`.
  subjectProfileId?: number;
}) {
  const [rows, setRows] = useState(practices);
  // Follow the gather whenever the sheet hands down a new one — the same server-wins
  // discipline the row control keeps over its own count.
  const [gathered, setGathered] = useState(practices);
  if (gathered !== practices) {
    setGathered(practices);
    setRows(practices);
  }

  const reread = useCallback(() => {
    void loadQuickEntry("practice", subjectProfileId).then(
      (data) => {
        if (data.form === "practice") setRows(data.practices);
      },
      // A dropped read leaves the rows exactly as they were. Nothing here is a write,
      // so there is no promise to walk back and nothing to say.
      () => {}
    );
  }, [subjectProfileId]);

  // THE EARLIEST DERIVED END ON SCREEN. One timer for the list: whichever row completes
  // first, the re-read that follows re-derives the next.
  useEffect(() => {
    const ends = rows.flatMap((row) =>
      row.liveSession?.expectedEnd ? [row.liveSession.expectedEnd.at] : []
    );
    if (ends.length === 0) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now()) + RE_READ_SLACK_MS;
    const timer = setTimeout(reread, wait);
    return () => clearTimeout(timer);
  }, [rows, reread]);

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
  if (rows.length === 0) {
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
    <ul
      data-testid="quick-entry-practice-list"
      className="divide-y divide-(--border) overflow-hidden rounded-lg border border-(--border) bg-surface"
    >
      {rows.map((practice) => {
        const facts = practiceRowFacts(practice);
        return (
          <li
            key={practice.identity}
            data-testid={`quick-entry-practice-${practice.identity}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800 dark:text-slate-100">
                {practice.name}
              </div>
              <div
                className="mt-0.5 text-sm text-slate-500 dark:text-slate-400"
                data-testid="practice-row-facts"
              >
                {practice.liveSession ? (
                  practiceRunningFacts(
                    practice.liveSession.startTime,
                    practice.liveSession.expectedEnd?.hhmm ?? null
                  )
                ) : (
                  <>
                    {facts.today && (
                      <span data-testid="practice-today-count">
                        {facts.today}
                      </span>
                    )}
                    {facts.today ? " · " : null}
                    {facts.week}
                  </>
                )}
              </div>
            </div>
            {/* No `showDetails`: the expanded date/time/duration form is a modal, and
                stacking one over this sheet is not what a one-tap surface is for; the
                Wellness card keeps that path.

                `inlineDuration` is the OTHER answer to the same objection (#2204). "20
                min sauna" vs "5 min" is most of what a practice log means, and the one
                surface that promised the fastest way to record one was the surface that
                threw it away. The pill's label arrives already holding this practice's
                last logged duration, so accepting it costs nothing and the tap is still
                one tap; the editor it opens is a control, not a form. */}
            <LogPracticeButton
              practice={practice.name}
              todayCount={practice.todayCount}
              today={today}
              defaultDurationMin={practice.previousDurationMin}
              liveSession={practice.liveSession}
              inlineDuration
              inlineWhen
              chipRow
              onServerRead={reread}
              subjectProfileId={subjectProfileId}
            />
          </li>
        );
      })}
    </ul>
  );
}
