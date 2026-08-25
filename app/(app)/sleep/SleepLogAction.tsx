"use client";

import { useState } from "react";
import Button from "@/components/Button";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";
import SleepMoodEditDialog from "./SleepMoodEditDialog";

export default function SleepLogAction({
  history,
  today,
  minDate,
  label = "Add entry",
  testId,
  formatPrefs,
}: {
  history: SleepMoodHistoryRow[];
  today: string;
  minDate: string;
  label?: string;
  testId?: string;
  // So the night chip reads a date the way the rest of the page does.
  formatPrefs?: DisplayFormatPrefs;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid={testId}>
        {label}
      </Button>
      {open && (
        <SleepMoodEditDialog
          mode="add"
          history={history}
          defaultDate={today}
          minDate={minDate}
          maxDate={today}
          formatPrefs={formatPrefs}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
