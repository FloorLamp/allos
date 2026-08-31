"use client";

import type { Route } from "next";
import { useRef, useState } from "react";
import { IconCalendar } from "@tabler/icons-react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import MonthCalendar from "@/components/MonthCalendar";
import { historyDayHref } from "@/lib/hrefs";

// THE RECORD'S EVENT CALENDAR — a month grid whose marked days are a door into
// the day view, opened from /history's own control row (#4280, completing
// #4102).
//
// IT LIVED IN THE NAV UNTIL NOW, and that is the whole subject of this file's
// history. It was `TrainingLogCalendar` with an `activeDates` prop while the app
// layout fed it `getTimelineDates` — the union of EVERY event store: body
// metrics, doses, symptoms, practices, immunizations, encounters, milestones,
// protocols, with training as one optional member. The name outlived the data
// and its `trainingRelevant` gate took the calendar away from exactly the
// profiles whose events it marks best. Both went in #3154. What went in #4102 is
// the PLACEMENT: a day grid is a way of reading a history, and the chrome is a
// way of reaching a page, so it costs the sidebar and the phone drawer nothing
// now and lives on the page whose subject is which day a thing happened.
//
// ONE HOST, AND IT IS THE SHARED FORK. `components/overlay/AnchoredPanel.tsx`
// already answers "what does an anchored panel open as, at this width": a
// portaled popover from `md` up, a bottom action sheet below it. The two hand-cut
// hosts this file used to carry — the sidebar's popover and the drawer's inline
// full-bleed band — collapse into that one primitive, so the phone gets the
// #1428 sheet every other anchored panel opens instead of a band unique to the
// drawer.
//
// THE PAGE IT SITS ON SPENDS NOTHING FOR IT. /history's chrome above its first
// record is bounded at ~140px (#3958, e2e/history.spec.ts) and measured 134 on
// the seeded admin at 390x844 — six pixels of room. A trigger inside the filter
// row that already exists is the only mount that fits: it adds no band, and the
// grid itself is not in the document until someone asks for it.
//
// No badge, no count, no dot on the trigger: the dock's never-campaigns doctrine
// (#2651) is about permanent chrome, and this is permanent chrome.

// THE GRID ITSELF IS components/MonthCalendar.tsx (#3744) — the same one
// DateField's picker renders. What is left here is the HOST and the binding: a
// marked day is a door into the record's day view, an unmarked one is inert, and
// the set of doors is the only thing this file tells the calendar.

// `w-72`, told to the positioner so the panel's first paint is already clamped
// inside the viewport rather than measured into place afterwards.
const PANEL_WIDTH_PX = 288;

// Where a marked day goes: the record's day view. Through the SHARED helper — this
// hand-built its own `/timeline?from=…&to=…#…` string, which is exactly why no sweep
// over `timelineDayHref` could see it when the route was retired.
const href = (day: string): Route => historyDayHref(day);

// SEVEN COLUMNS THAT CLEAR THE TAP FLOOR, CLAIMED RATHER THAN ASSUMED
// (#3377/#3452). `--week-grid-min` is what seven 44px columns cost, stated once
// in app/globals.css; below `md` the sheet is the host and its own `px-4` is
// cancelled here so the grid runs the full width of the screen. Without both
// terms a 320px viewport lays the week out at 41px a column — under the floor,
// redistributed quietly, and invisible to any DOM assertion, which is the #3377
// failure. From `md` up the popover is 288px wide and sets its own padding, so
// neither applies: a fine pointer gets the control box, not the tap floor
// (e2e/mobile-ui-polish.spec.ts measures both).
const GRID_HOST =
  "-mx-4 max-md:min-w-(--week-grid-min) py-3 md:mx-0 md:p-3";

export default function EventCalendar({
  eventDates,
}: {
  eventDates: string[];
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="history-calendar"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="history-calendar-panel"
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost btn-sm shrink-0"
      >
        <IconCalendar className="h-4 w-4 shrink-0" stroke={1.75} />
        Calendar
      </button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Calendar"
        // What the trigger's `aria-haspopup="dialog"` above already promises, made
        // true: the role, the name, and focus moving in (#3905). Not `aria-modal`
        // — nothing here locks the page behind it.
        role="dialog"
        panelId="history-calendar-panel"
        testId="history-calendar-panel"
        sheetTestId="history-calendar-sheet"
        fallbackWidth={PANEL_WIDTH_PX}
        panelClassName="w-72"
      >
        {/* A Link inside the panel ends the interaction, and the primitive cannot
            know that: without this the grid stays floating over the record day it
            just opened (#3905). */}
        {() => (
          <div className={GRID_HOST}>
            <MonthCalendar
              binding={{
                kind: "linked",
                dates: eventDates,
                href,
                onNavigate: () => setOpen(false),
              }}
            />
          </div>
        )}
      </AnchoredPanel>
    </>
  );
}
