"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveDisplayFormatPrefs } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  formatClock,
  formatDateShape,
  type DateFormat,
  type DisplayFormatPrefs,
  type TimeFormat,
} from "@/lib/format-date";

// Date & time display preferences — a LOGIN-scoped setting (#964), the sibling of
// the Units card. Autosaves on change like the other Preferences cards (#794).
// The option labels preview the actual output so the choice is concrete. A sample
// instant (the 5th at 16:02) drives both previews through the SAME pure seam the
// app renders with, so what you pick is what you get.
const SAMPLE = { y: 2026, m: 1, d: 5, h: 16, min: 2 };

const DATE_OPTIONS: { value: DateFormat; label: string }[] = (
  ["mdy", "dmy", "iso"] as DateFormat[]
).map((value) => ({
  value,
  label: formatDateShape(value, SAMPLE.y, SAMPLE.m, SAMPLE.d, {
    monthStyle: "short",
    year: true,
  }),
}));

const TIME_OPTIONS: { value: TimeFormat; label: string }[] = (
  ["24h", "12h"] as TimeFormat[]
).map((value) => ({
  value,
  label: `${value === "24h" ? "24-hour" : "12-hour"} — ${formatClock(
    value,
    SAMPLE.h,
    SAMPLE.min
  )}`,
}));

export default function FormatPrefsForm({
  prefs,
}: {
  prefs: DisplayFormatPrefs;
}) {
  const router = useRouter();
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(prefs.timeFormat);
  const [dateFormat, setDateFormat] = useState<DateFormat>(prefs.dateFormat);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: { timeFormat: TimeFormat; dateFormat: DateFormat }) {
    const fd = new FormData();
    fd.set("time_format", next.timeFormat);
    fd.set("date_format", next.dateFormat);
    runSave(async () => {
      await saveDisplayFormatPrefs(fd);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Date &amp; time
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label">Time format</label>
        <select
          data-testid="time-format-select"
          value={timeFormat}
          onChange={(e) => {
            const v = e.target.value as TimeFormat;
            setTimeFormat(v);
            save({ timeFormat: v, dateFormat });
          }}
          className="input"
        >
          {TIME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The clock used for timestamps across the app.
        </p>
      </div>

      <div>
        <label className="label">Date format</label>
        <select
          data-testid="date-format-select"
          value={dateFormat}
          onChange={(e) => {
            const v = e.target.value as DateFormat;
            setDateFormat(v);
            save({ timeFormat, dateFormat: v });
          }}
          className="input"
        >
          {DATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          How written dates are ordered. Data entry stays ISO (YYYY-MM-DD);
          this changes display only.
        </p>
      </div>
    </div>
  );
}
