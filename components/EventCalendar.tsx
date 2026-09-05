"use client";

import type { Route } from "next";
import { useRef, useState } from "react";
import { IconCalendar } from "@tabler/icons-react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import MonthCalendar from "@/components/MonthCalendar";
import { historyHref } from "@/lib/hrefs";

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

// THE GRID TAKES ITS HOST'S WIDTH AND DOES NOT REACH PAST IT (#4280). The sheet
// pads its own content by 16px a side and CLIPS what overflows — it declares
// `overflow-x: hidden` so a coarse pointer's trailing hit-slop cannot be nudged
// into a scroll (components/BottomSheet.tsx says so on the element itself). A
// full-bleed band like the one the phone drawer used to draw is therefore not a
// band here, and this was MEASURED rather than reasoned about: pulled out to the
// screen edges, the grid's first and last columns were clipped 16px each at both
// 320 and 390, and focusing the Next-month arrow scrolled the clipped panel 16px
// left — leaving the Previous-month arrow half off the panel with no
// user-reachable way back, because a hidden overflow is not scrollable by hand.
//
// WHAT THAT COSTS, STATED: the week is the sheet's content width divided by
// seven, so a 390px viewport gives 51px columns and clears the 44px inline floor
// (#3514), and a 320px one gives 41px and does not. `--week-grid-min` was the
// token that used to buy the difference, by widening the phone nav drawer around
// the band; a padded sheet cannot spend it — seven 44px columns are 308px and a
// 320px viewport leaves 288 — so the token retired with the drawer's claim on it
// rather than becoming a min-width that could only clip.
// e2e/mobile-ui-polish.spec.ts measures the columns at both widths and the floor
// at the width that can pay it.
const GRID_HOST = "md:p-3";

// THE BINDING, EXTRACTED FROM THE HOST (#4974). The record now mounts this grid in
// two places — behind the door below, and open in the day view's `xl` rail — and
// what they share is not the popover but the ANSWER to "what does a marked day
// mean". `MonthCalendar`'s `href` is a function, which a Server Component cannot
// hand across the RSC boundary, so the binding has to live on the client side of it
// anyway; putting it here rather than beside each mount is what keeps one answer.
//
// Where a marked day goes: the record's day view, in the SAME view the grid was read
// in. Through the SHARED helper — this hand-built its own `/timeline?from=…&to=…#…`
// string, which is exactly why no sweep over `timelineDayHref` could see it when the
// route was retired. `everyone` rides across because every other href on /history
// carries it (chipHref, dayNavHref, foldHref): once the marks union, a door that
// dropped the mode would open a household day on the acting profile alone — a lit
// day leading to an empty one.
export function EventMonthGrid({
  eventDates,
  everyone = false,
  onNavigate,
}: {
  /** Every day the VIEWED members have an event on — the page's union (#4393). */
  eventDates: string[];
  /** The feed's mode, so a marked day opens inside the view it was marked from. */
  everyone?: boolean;
  /** A popover host closes on a destination; an inline one has nothing to close. */
  onNavigate?: () => void;
}) {
  const href = (day: string): Route => historyHref({ day, everyone });
  return (
    <MonthCalendar
      binding={{ kind: "linked", dates: eventDates, href, onNavigate }}
    />
  );
}

export default function EventCalendar({
  eventDates,
  everyone = false,
}: {
  /** Every day the VIEWED members have an event on — the page's union (#4393). */
  eventDates: string[];
  /** The feed's mode, so a marked day opens inside the view it was marked from. */
  everyone?: boolean;
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
            <EventMonthGrid
              eventDates={eventDates}
              everyone={everyone}
              onNavigate={() => setOpen(false)}
            />
          </div>
        )}
      </AnchoredPanel>
    </>
  );
}
