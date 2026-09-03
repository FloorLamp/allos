"use client";

import { useEffect, useRef } from "react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";

// BACKFILL BY DATE (#2420, carried across #4079's re-housing). A day-history panel's
// "log a workout for this day" link lands on `/training?tab=log&date=YYYY-MM-DD`; the
// date is validated and bounded server-side, and this opens the editor on it once.
//
// The param is CONSUMED on arrival, so a re-render or an autosave cannot open a
// second blank editor — and the tab and every other refinement stay in the URL,
// because the reader is still standing in the Log they came to.
export default function TrainingLogCreateOnArrival({ date }: { date: string }) {
  const { openCreate } = useActivityEditor();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    openCreate({ date });
    const url = new URL(window.location.href);
    url.searchParams.delete("date");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [date, openCreate]);

  return null;
}
