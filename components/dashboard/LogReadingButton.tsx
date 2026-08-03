"use client";

import { IconPlus } from "@tabler/icons-react";
import { useQuickEntry } from "@/components/QuickEntryProvider";

// "Log reading" for the Latest-vitals card (issue #1892, the vitals twin).
//
// The card used to carry a log affordance ONLY in its empty state: a profile with no
// BP/resting-HR reading got a CTA, and the moment one existed the card went
// display-only. So the person who logs blood pressure weekly for months — the one who
// actually looks at this card — had no affordance on it at all, while the person who
// never logs got one. This restores the action to BOTH states.
//
// No new write path and no new form: it opens the SAME shared measurements quick-entry
// (#1468/#1486) the empty CTA now opens and the phone's quick-log sheet mounts, which
// posts the same addMeasurements action with its own gates. One form, more doors.
export default function LogReadingButton({
  label = "Log reading",
}: {
  label?: string;
}) {
  const { open } = useQuickEntry();
  return (
    <button
      type="button"
      className="btn btn-sm"
      data-testid="vitals-log-reading"
      onClick={() => open("measurements")}
    >
      <IconPlus className="h-4 w-4" stroke={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}
