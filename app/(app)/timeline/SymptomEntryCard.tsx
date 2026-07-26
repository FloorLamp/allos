"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import Collapse from "@/components/Collapse";

// The Timeline day view's retro symptom entry, behind a "+ Log symptom" affordance
// (issue #1517 C — the #1497 rare-cadence-entry rule).
//
// The bar itself (#799) is a large fixed block: a heading plus severity chips,
// notes, custom names and the temperature quick-entry. It rendered OPEN on every
// single-day view whether or not you were logging symptoms, which on a phone is a
// permanent tax on the day's actual content for a control most days never touch.
//
// AUTO-EXPANDED WHEN IT IS THE POINT OF THE VISIT — the day already has symptom
// entries (you are amending), or an illness-type situation is active (you are sick;
// this is the flow #799 built it for). That keeps the sick-day path one tap while an
// ordinary day gets the space back. The decision is the SERVER's (`defaultOpen`) —
// it reads the day's rows and the profile's active situations — and it is the
// initial state only, never a controlled value: once you have opened or closed the
// panel, the next render must not yank it back.
//
// The panel stays MOUNTED while collapsed (that is what lets it animate, and what
// keeps a deep link's server-rendered state intact); <Collapse> takes it out of the
// accessibility tree and the tab order so a hidden form is never a keyboard trap.
export default function SymptomEntryCard({
  dateLabel,
  defaultOpen,
  children,
}: {
  // The day being logged, already formatted in the login's date-format preference.
  dateLabel: string;
  defaultOpen: boolean;
  // The server-rendered <SymptomLogBar>.
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      data-testid="timeline-symptom-entry"
      data-open={open ? "true" : "false"}
      // Collapsed it is a bare affordance, not a card: a bordered box holding one
      // button would give most of the block back and then charge for the frame.
      className={open ? "card mb-5" : "mb-5"}
    >
      <button
        type="button"
        data-testid="timeline-symptom-toggle"
        aria-expanded={open}
        aria-controls="timeline-symptom-panel"
        onClick={() => setOpen((v) => !v)}
        className={
          open
            ? "flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-slate-800 dark:text-slate-100"
            : "btn-secondary text-sm"
        }
      >
        {open ? (
          <>
            <span>Log symptoms for {dateLabel}</span>
            <IconChevronDown
              className="h-4 w-4 shrink-0 rotate-180 transition-transform"
              aria-hidden="true"
            />
          </>
        ) : (
          <>
            <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
            Log symptom
          </>
        )}
      </button>
      <Collapse open={open}>
        <div id="timeline-symptom-panel" className="pt-3">
          {children}
        </div>
      </Collapse>
    </div>
  );
}
