"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveMinTrainingAge } from "./actions";
import SaveStatus from "@/components/SaveStatus";

// The GLOBAL minimum age (whole years) for the fitness-oriented surfaces. When a
// profile's known age is below it, the Training and AI Insights pages,
// the Equipment settings tab, and their dashboard widgets are hidden for that
// profile. Admin-only. Empty disables the gate (everyone has full access).
export default function AgeGateSettings({
  minTrainingAge,
}: {
  minTrainingAge: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(
    minTrainingAge != null ? String(minTrainingAge) : ""
  );
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);

  function save() {
    const fd = new FormData();
    fd.set("min_training_age", value.trim());
    startTransition(async () => {
      await saveMinTrainingAge(fd);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Minimum age for training features
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Profiles whose age is below this are shown a slimmed-down app: the
        Training and AI Insights pages, the Equipment settings tab, and the
        related dashboard cards are hidden. A profile with no birthdate or age
        set is never restricted. Leave empty to disable the gate entirely.
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
