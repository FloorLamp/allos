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
  variant,
}: {
  history: SleepMoodHistoryRow[];
  today: string;
  minDate: string;
  label?: string;
  testId?: string;
  // So the night chip reads a date the way the rest of the page does.
  formatPrefs?: DisplayFormatPrefs;
  // Forwarded, never chosen here: this component renders at three mounts of three
  // different ranks (#3982). The page header's is the page's own action and was
  // filled (`btn btn-sm`) until #3759; the stale-card and empty-state mounts were
  // LINK-styled, so promoting them would invent a rank neither ever had.
  variant?: "primary";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
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
