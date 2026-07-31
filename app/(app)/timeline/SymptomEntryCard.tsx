import type { ReactNode } from "react";
import AddEntryPanel from "@/components/AddEntryPanel";

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
// The disclosure MECHANICS — mounted-while-collapsed (so it can animate and a deep
// link's server-rendered state survives), `aria-hidden` + out of the tab order while
// closed, the collapsed "+" affordance vs the open heading — are the shared
// components/AddEntryPanel since #1499 applied the same rule to the Results hub's
// entry forms. This file is the Timeline's copy deck over it, not a second
// implementation of the behavior.
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
  return (
    <AddEntryPanel
      label={`Log symptoms for ${dateLabel}`}
      addLabel="Log symptom"
      defaultOpen={defaultOpen}
      panelId="timeline-symptom-panel"
      testId="timeline-symptom-entry"
      toggleTestId="timeline-symptom-toggle"
      dense
    >
      {children}
    </AddEntryPanel>
  );
}
