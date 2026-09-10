"use client";

import { useState } from "react";
import HistoryAddDoor, {
  type HistoryAddKind,
  type HistoryAddVocabulary,
} from "./HistoryAddDoor";
import HistoryWorkoutDoor from "./HistoryWorkoutDoor";
import { useIntradayInteraction } from "@/components/IntradayInteraction";
import { intradayWindowParams, windowFromView } from "@/lib/intraday-window";
import { formatClockMinutes } from "@/lib/format-date";
import type { TimeFormat } from "@/lib/format-date";
import {
  practiceFittingWindow,
  type PracticeWindowCandidate,
} from "@/lib/practice";

// THE ADD ROW READS THE WINDOW THE CHART IS ALREADY SHOWING (#4950, owner amendment).
//
// There is no chip to arm and no mode to be in: zoomed, the view IS the window; at full
// day a pinned minute is a start alone.
//
// AND A KIND CHIP OPENS ITS FORM (#5618 ruling 1) — "otherwise the whole page changes
// when you want to add something". Each chip was a link to `?kind=`, so tapping one
// narrowed the record to that kind, swapped this whole row for a single door button,
// and left the reader to find and press that button before any form appeared. Three
// things went with it: the navigation, the second tap, and the page's own claim that
// asking which kind to add is the same act as filtering the rows to it.
//
// SO THE ROW OWNS THE OPEN CHIP. A record has one add layer and one form open in it;
// the door below is a form host with no closed state of its own, and this is the one
// place that knows which chip is pressed.
//
// THE FILTER PILLS REMAIN THE ONLY FILTER. `/history?kind=substance` still narrows the
// record, through them, and its add row is identical to All's — the chip set is the
// PROFILE's kinds (`presentKinds` is filter-independent by contract), not the view's.
//
// The labels and the kinds are still the server's, handed down whole.
export interface HistoryAddChip {
  kind: HistoryAddKind;
  label: string;
}

export default function HistoryAddRow({
  chips,
  timeFormat,
  date,
  maxDate,
  vocabulary,
  practiceCandidates = [],
  workoutsDate = null,
}: {
  chips: readonly HistoryAddChip[];
  timeFormat: TimeFormat;
  /** The day every form here opens on — the day being read, or today on the feed. */
  date: string;
  /** This profile's own today: the record's never-the-future bound at every kind. */
  maxDate: string;
  vocabulary: HistoryAddVocabulary;
  /**
   * The practices whose weekly rhythm could fit a window on `date` (#4950 item 4), read
   * server-side and matched HERE because the window is the chart's live one now. Habit,
   * never physiology: `practiceFittingWindow` never sees a heart rate, and a practice
   * with no rhythm cannot fit. Empty wherever there is no chart to state a window.
   */
  practiceCandidates?: readonly PracticeWindowCandidate[];
  /**
   * The day the workouts door writes into, or null where there is no day — the feed
   * has no chart, so it has no window and no day to open an activity on (#4950 item 5).
   */
  workoutsDate?: string | null;
}) {
  const { view, pin } = useIntradayInteraction();
  const [openKind, setOpenKind] = useState<HistoryAddKind | null>(null);
  const window = windowFromView(view, pin);
  const params = window ? intradayWindowParams(window) : null;
  const clock = (minute: number) => formatClockMinutes(timeFormat, minute);
  // "Add at 19:10–20:40" for a span, "Add at 19:10" for a start alone, "Add" for
  // neither — the row says what it would write into, and says nothing when it has
  // nothing to say.
  const label =
    window == null
      ? "Add"
      : window.to == null
        ? `Add at ${clock(window.from)}`
        : `Add at ${clock(window.from)}–${clock(window.to)}`;
  const defaultPractice = window
    ? practiceFittingWindow(practiceCandidates, date, window)
    : null;

  return (
    /* Geometry unchanged from the server version this replaced: it scrolls rather than
       wraps for the same reason the filter row does. */
    <div className="-mx-2 flex items-center gap-3 overflow-x-auto px-2 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {/* "Add", not "Add past" (#4918 ruling 5): on the day view the day bar states the
          day being written to, and on the feed the door is bounded by today anyway. */}
      <span
        className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400"
        data-testid="history-add-label"
      >
        {label}
      </span>
      {chips.map((chip) => (
        <HistoryAddDoor
          key={chip.kind}
          kind={chip.kind}
          label={chip.label}
          open={openKind === chip.kind}
          onOpen={() => setOpenKind(chip.kind)}
          onClose={() => setOpenKind(null)}
          date={date}
          maxDate={maxDate}
          vocabulary={vocabulary}
          window={params}
          defaultPractice={defaultPractice}
        />
      ))}
      {workoutsDate ? (
        <HistoryWorkoutDoor date={workoutsDate} window={params} />
      ) : null}
    </div>
  );
}
