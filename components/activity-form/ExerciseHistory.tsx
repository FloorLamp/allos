"use client";

import { useState } from "react";
import { IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
import Collapse from "@/components/Collapse";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatLongDate } from "@/lib/format-date";
import { summarizeExercise } from "@/lib/training-log-format";
import { rpeSummaryText } from "@/lib/rpe";
import type { ExerciseHistoryMap } from "@/lib/queries";
import type { WeightUnit } from "@/lib/settings";

type PriorSession = ExerciseHistoryMap[string]["sessions"][number];

// HISTORY IS ONE LINE (#5370). The last session states itself under the exercise
// heading; the two older ones and the plateau/deload note are one tap behind it.
// Nothing the old card showed is gone — a six-exercise session simply stops spending
// six screens on reference above the numbers being typed. The "RECENT" caption goes
// with the fold: a single dated line does not need one.
//
// THE FILL GESTURE IS UNTOUCHED, which is the whole risk here. Each row is a "repeat
// this session" fill path (#923) while the part is pristine (the caller's untouched
// gate, the same one the ghosts read, so a tap can never clobber entry in progress) —
// and every older session is still a tap away behind the fold, because a light/off
// last day makes the one before it useful. Once anything is typed the rows revert to
// read-only reference.
export default function ExerciseHistory({
  sessions,
  fillable,
  onFill,
  unit,
  note,
}: {
  // Newest first, already narrowed to this part's load context by the caller.
  sessions: PriorSession[];
  fillable: boolean;
  onFill: (sets: PriorSession["sets"]) => void;
  unit: WeightUnit;
  // The plateau/deload note, when there is one — it rides behind the same fold.
  note: React.ReactNode;
}) {
  // Closed on arrival on every part: the point of the fold is that a six-exercise
  // session opens with six one-line references rather than six cards.
  const [open, setOpen] = useState(false);
  const formatPrefs = useFormatPrefs();
  if (sessions.length === 0) return null;
  // Is there anything behind the line? Older sessions, a note, or both. Nothing to
  // fold means no chevron and no empty panel.
  const folded = sessions.length > 1 || note !== null;

  // ONE ROW RENDERER, wherever it renders — which is what keeps the promise that
  // folding costs none of the fill gesture: a row below the fold cannot drift into a
  // different control from the row above it.
  const row = (sess: PriorSession) => {
    const dateEl = (
      <span className="shrink-0 text-slate-500 dark:text-slate-400">
        {formatLongDate(sess.date, formatPrefs)}
      </span>
    );
    const metrics = (
      <span className="flex items-center gap-1 tabular-nums">
        {summarizeExercise(sess.sets, unit).text}
        {/* Logged RPE for the session, shown when present (#743). */}
        {rpeSummaryText(sess.sets) && (
          <span className="rounded-sm bg-slate-100 px-1 text-xs font-medium text-slate-500 dark:bg-ink-800 dark:text-slate-400">
            {rpeSummaryText(sess.sets)}
          </span>
        )}
        {/* Same missed-target marker as the training log card; the session status is
            judged server-side. */}
        {sess.status === "missed" && (
          <span className="inline-flex items-center gap-0.5 text-xs text-amber-500 dark:text-amber-400">
            <IconAlertTriangle className="h-3.5 w-3.5" stroke={2} />
            Missed target
          </span>
        )}
      </span>
    );
    return fillable ? (
      <button
        type="button"
        data-testid="recent-session-fill"
        onClick={() => onFill(sess.sets)}
        className="-mx-1 flex w-full items-center justify-between gap-3 rounded-sm px-1 py-0.5 text-left text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
      >
        {dateEl}
        <span className="flex items-center gap-2">
          {metrics}
          <span className="shrink-0 rounded-sm border border-brand-300 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:border-brand-800 dark:text-brand-400">
            Fill
          </span>
        </span>
      </button>
    ) : (
      <div className="flex items-center justify-between gap-3 text-slate-600 dark:text-slate-300">
        {dateEl}
        {metrics}
      </div>
    );
  };

  return (
    <div
      data-testid="recent-sessions"
      className="mt-2 rounded-md border border-black/10 bg-surface px-2.5 py-1.5 text-xs dark:border-white/10"
    >
      <ul className="space-y-0.5">
        <li className="flex items-center gap-1">
          <span className="min-w-0 flex-1">{row(sessions[0])}</span>
          {folded && (
            <button
              type="button"
              data-testid="recent-more-toggle"
              aria-expanded={open}
              aria-label={open ? "Hide earlier sessions" : "Earlier sessions"}
              onClick={() => setOpen((v) => !v)}
              className="tap-target flex shrink-0 items-center justify-center rounded-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
            >
              <IconChevronDown
                className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                stroke={2}
                aria-hidden="true"
              />
            </button>
          )}
        </li>
      </ul>
      {folded && (
        <Collapse open={open} testId="recent-more">
          <ul className="space-y-0.5 pt-0.5">
            {sessions.slice(1).map((sess, i) => (
              <li key={i}>{row(sess)}</li>
            ))}
          </ul>
          {note}
        </Collapse>
      )}
    </div>
  );
}
