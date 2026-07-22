"use client";

import { useState } from "react";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";
import SleepMoodEditDialog from "./SleepMoodEditDialog";

export default function SleepLogAction({
  history,
  today,
  minDate,
  label = "Add entry",
  className = "btn btn-sm",
  testId,
}: {
  history: SleepMoodHistoryRow[];
  today: string;
  minDate: string;
  label?: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`${className} whitespace-nowrap`}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        {label}
      </button>
      {open && (
        <SleepMoodEditDialog
          mode="add"
          history={history}
          defaultDate={today}
          minDate={minDate}
          maxDate={today}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
