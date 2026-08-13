"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import Collapse from "@/components/Collapse";

// The FOLD over the trying-to-conceive section's not-active branch (#2583 part 2).
//
// The declared-only doctrine (#1680) already keeps TTC CONTENT off until the user says
// so, and that half was never the problem. The OFFER was: a full card carrying an
// explainer paragraph and a live "Date you started trying" date field stood open on
// every visit to /medical/cycles, permanently, for the most personal topic in the app —
// asked of people who are not trying to conceive, who are past it, or who lost a
// pregnancy, every single time they came to log a period.
//
// So the not-active state spends ONE QUIET LINE and nothing else. The line still names
// the topic and its state ("off"), because a fold that hides what it is would be worse
// than the standing card: someone looking for this must still find it, and finding it
// must not require guessing. Expanding reveals exactly today's content, unchanged.
//
// Deliberately NOT <AddEntryPanel>: that is the #1497 rare-cadence ADD-ENTRY primitive,
// and its collapsed affordance is a "+ Add …" button. Turning on a health topic is not
// adding an entry, and a ＋ would read as "add a pregnancy". This is a route-local
// disclosure over the same shared <Collapse>, which keeps the folded controls out of
// the tab order and the accessibility tree while they are hidden.
//
// The other two branches are UNTOUCHED (declared/active renders the full section,
// pregnancy-paused renders its own), and so is the `!isMinor` adult gate on the page —
// a minor's page renders no line at all, because it renders no TtcSection at all.
export default function TtcOffDisclosure({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = "ttc-off-panel";

  return (
    <section
      data-testid="ttc-section"
      data-open={open ? "true" : "false"}
      // Collapsed it is a line, not a card. A bordered box holding one sentence would
      // give back the height the fold just bought and then charge for the frame.
      className={open ? "card" : ""}
    >
      <button
        type="button"
        data-testid="ttc-off-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={
          open
            ? "flex w-full items-center justify-between gap-2 py-1 text-left text-sm font-semibold text-slate-800 dark:text-slate-100"
            : "flex w-full items-center justify-between gap-2 py-2 text-left text-sm text-slate-500 transition hover:text-slate-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:text-slate-200"
        }
      >
        {/* One string per state rather than a fragment plus a conditional tail: the
            line is asserted verbatim, and JSX text/expression whitespace joining is
            not a thing a copy assertion should have to reason about. */}
        <span>
          {open
            ? "Trying to conceive · off"
            : "Trying to conceive · off — tap to turn on tracking"}
        </span>
        <IconChevronDown
          className={`h-4 w-4 shrink-0 transition-transform${
            open ? " rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>
      <Collapse open={open}>
        <div id={panelId} className="space-y-3 pt-3">
          {children}
        </div>
      </Collapse>
    </section>
  );
}
