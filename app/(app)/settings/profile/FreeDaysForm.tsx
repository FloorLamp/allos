"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WEEKDAYS_LONG } from "@/lib/date";
import { saveFreeDays } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Free-days card (issue #1241) — the PROFILE-scoped set of off-days (0=Sun … 6=Sat)
// that the Sleep Regularity card's social-jetlag figure splits on. The weekend guess
// (Sat/Sun) is wrong for shift workers/nurses, so this lets a profile declare its own
// free days. Toggling a day autosaves, like the other profile checkbox cards; the
// social-jetlag number only refines — every other sleep-regularity figure is
// unchanged. Renders all seven days so a submission is always complete (an empty set
// is an explicit "no free days").
export default function FreeDaysForm({ freeDays }: { freeDays: number[] }) {
  const router = useRouter();
  const [set, setSet] = useState<Set<number>>(new Set(freeDays));
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function persist(next: Set<number>) {
    setSet(next);
    const fd = new FormData();
    for (const d of next) fd.append("free_days", String(d));
    runSave(async () => {
      await saveFreeDays(fd);
      router.refresh();
    });
  }

  function toggle(day: number) {
    const next = new Set(set);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    persist(next);
  }

  return (
    <div className="card max-w-lg space-y-4" data-testid="free-days-form">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Free days
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Your days off work or school. The Sleep Regularity card compares your
        mid-sleep on free days versus work days to estimate social jetlag —
        defaults to the weekend (Sat/Sun), so change it only if your free days
        aren&rsquo;t Saturday and Sunday (shift or rotating schedules).
      </p>

      <fieldset>
        <legend className="label mb-1">Off days</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {WEEKDAYS_LONG.map((name, day) => (
            <label
              key={day}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
            >
              <input
                type="checkbox"
                data-testid={`free-day-${day}`}
                checked={set.has(day)}
                onChange={() => toggle(day)}
                className="h-4 w-4 rounded border-black/20 dark:border-white/20"
              />
              {name}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
