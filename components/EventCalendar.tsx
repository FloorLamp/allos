"use client";

import type { Route } from "next";
import { useRef, useState } from "react";
import { IconCalendar } from "@tabler/icons-react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import MonthCalendar from "@/components/MonthCalendar";
import { useCompactViewport } from "@/components/useCompactViewport";
import { historyDayHref } from "@/lib/hrefs";

// THE SIDEBAR'S EVENT CALENDAR — a month grid whose marked days are a door into
// the Timeline (#3079's usage review), one row at rest (#3154).
//
// IT IS NOT A TRAINING CALENDAR AND HAS NOT BEEN FOR A LONG TIME. It was named
// `TrainingLogCalendar` with an `activeDates` prop, and the app layout fed it
// `getTimelineDates` — the union of EVERY event store: body metrics, doses,
// symptoms, practices, immunizations, encounters, milestones, protocols, with
// training as one optional member. The name outlived the data, and the
// `trainingRelevant` gate that came with it took the calendar away from exactly
// the profiles whose events it marks best — a child's immunizations, milestones
// and symptoms. Both are gone; the union itself (lib/timeline.ts) is untouched.
//
// TWO HOSTS, ONE GRID, the fork components/overlay/AnchoredPanel.tsx already
// makes for every other anchored panel in the app:
//
//   * FROM `md` UP — one ~40px "Calendar" row that opens the grid in an anchored
//     popover, over the same primitive the sidebar's "+ Log" panel uses. The
//     resting cost was ~230px of permanent single-column chrome, which is what
//     pushed Data, Settings and the whole footer below the fold; the popover is
//     portaled and `fixed`, so opening it shifts neither the nav nor the footer,
//     and the grid is no longer confined to the column's width.
//   * BELOW `md` — the phone drawer's full-bleed band, unchanged. The drawer
//     scrolls, so it never had the fold problem the row solves, and its 44px
//     columns are a tap-floor claim (#3377/#3452/#3536) that a popover would
//     drop on the floor.
//
// No badge, no count, no dot on the row: the dock's never-campaigns doctrine
// (#2651) applies to permanent chrome wherever it sits.

// THE GRID ITSELF IS components/MonthCalendar.tsx (#3744) — the same one
// DateField's picker renders. What is left here is the two HOSTS and the binding:
// a marked day is a door into the record's day view, an unmarked one is inert, and
// the set of doors is the only thing this file tells the calendar.

// `w-72`, told to the positioner so the panel's first paint is already clamped
// inside the viewport rather than measured into place afterwards.
const PANEL_WIDTH_PX = 288;

// Where a marked day goes: the record's day view. Through the SHARED helper — this
// hand-built its own `/timeline?from=…&to=…#…` string, which is exactly why no sweep
// over `timelineDayHref` could see it when the route was retired.
const href = (day: string): Route => historyDayHref(day);

// The phone drawer's band, CLAIMED rather than assumed (#3377/#3452). Its
// `min-w-(--week-grid-min)` is what seven 44px columns cost, stated once in
// app/globals.css and read here and by the drawer's own width class (#3536) —
// slack at every width the drawer offers, which is the point: a host narrower
// than a week overflows visibly instead of quietly redistributing the columns
// back under the tap floor, the failure #3377 found and no DOM assertion would
// have caught. The band gives up the drawer's right gutter and the part of its
// left gutter outside the safe-area inset, so its left edge lands exactly on
// `env(safe-area-inset-left)` and never behind it; the side borders and corner
// radius go with it, so it reads as a band rather than a card jammed against the
// drawer's edges.
const PHONE_BAND =
  "-mr-4 ml-[calc(env(safe-area-inset-left)_-_max(1rem,env(safe-area-inset-left)))] min-w-(--week-grid-min) border-y border-black/10 py-3 dark:border-white/10";

export default function EventCalendar({
  eventDates,
}: {
  eventDates: string[];
}) {
  const compact = useCompactViewport();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (compact)
    return (
      <div className={PHONE_BAND}>
        <MonthCalendar binding={{ kind: "linked", dates: eventDates, href }} />
      </div>
    );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="sidebar-calendar"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="sidebar-calendar-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-slate-600 transition hover:bg-(--ghost-hover) dark:text-slate-300"
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
        panelId="sidebar-calendar-panel"
        testId="sidebar-calendar-panel"
        fallbackWidth={PANEL_WIDTH_PX}
        panelClassName="w-72"
      >
        {/* `open` lives in a layout App Router does not remount, so without this
            the grid stays floating over the Timeline day it just opened (#3905).
            The primitive cannot know a Link inside it ends the interaction. */}
        {() => (
          <div className="p-3">
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
