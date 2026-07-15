"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveMinTrainingAge } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The GLOBAL minimum age (whole years) for the ADULT fitness-content surfaces.
// When a profile's known age is below it, the adult training analytics (strength
// e1RM/standards, fitness-age, coaching, goals), AI Insights, the Equipment
// registry, and their dashboard widgets are hidden. Duration-based SPORT/CARDIO
// logging survives (issue #489) — a restricted profile keeps a lightweight
// activity log on /training. Admin-only. Empty disables the gate entirely.
export default function AgeGateSettings({
  minTrainingAge,
}: {
  minTrainingAge: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(
    minTrainingAge != null ? String(minTrainingAge) : ""
  );
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save() {
    const fd = new FormData();
    fd.set("min_training_age", value.trim());
    runSave(async () => {
      await saveMinTrainingAge(fd);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Minimum age for training features
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Profiles whose age is below this are shown a slimmed-down app: the adult
        training analytics (1-rep-max, strength standards, fitness age,
        coaching, goals), AI Insights, the Equipment registry, and the related
        dashboard cards are hidden. Duration-based sport and cardio logging
        still works — they get a lightweight activity log instead. A profile
        with no birthdate or age set is never restricted. Leave empty to disable
        the gate entirely.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <input
            type="number"
            min={1}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 18 (empty = off)"
            className="input"
          />
        </div>
        <button type="button" onClick={save} disabled={pending} className="btn">
          Save
        </button>
      </div>
    </div>
  );
}
