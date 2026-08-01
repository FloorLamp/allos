"use client";

import { useState } from "react";
import {
  PROTEIN_GOAL_LEVELS,
  PROTEIN_GOAL_OPTION_LABELS,
  proteinGoalBand,
  type ProteinGoalLevel,
} from "@/lib/protein";
import { saveProteinGoal } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Protein goal card (issue #1503) — the PROFILE-scoped training goal that selects the
// protein g/kg band (lib/protein GOAL_BANDS). The adequacy engine has read this setting
// since #767; until now nothing wrote it, so a cut or hypertrophy phase could not move
// its own target off the "active" band.
//
// INFORMATIONAL, never a prescription: the band is a reference range the gauge and the
// adequacy copy frame as context, and lean mass is the preferred basis when it's
// tracked. Saves on change, like the dietary-preferences card it sits beside.

export default function ProteinGoalForm({
  goal,
  embedded = false,
}: {
  // The profile's effective goal level (the stored pick, or the default when unset).
  goal: ProteinGoalLevel;
  // Modal consumers provide their own card shell and title.
  embedded?: boolean;
}) {
  const [level, setLevel] = useState<ProteinGoalLevel>(goal);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const band = proteinGoalBand(level);

  function persist(next: ProteinGoalLevel) {
    setLevel(next);
    const fd = new FormData();
    fd.set("protein_goal", next);
    runSave(async () => {
      const res = await saveProteinGoal(fd);
      if (!res.ok) throw new Error(res.error);
    });
  }

  return (
    <div
      className={embedded ? "space-y-4" : "card max-w-lg space-y-4"}
      data-testid="protein-goal-form"
    >
      <div
        className={`flex items-center ${
          embedded ? "justify-end" : "justify-between"
        }`}
      >
        {!embedded && (
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Protein goal
          </h2>
        )}
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label" htmlFor="protein-goal">
          Training goal
        </label>
        <select
          id="protein-goal"
          data-testid="protein-goal"
          className="input"
          value={level}
          onChange={(e) => persist(e.target.value as ProteinGoalLevel)}
        >
          {PROTEIN_GOAL_LEVELS.map((l) => (
            <option key={l} value={l}>
              {PROTEIN_GOAL_OPTION_LABELS[l]}
            </option>
          ))}
        </select>
        <p
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="protein-goal-band"
        >
          Sets your protein band to {band.low}–{band.high} g/kg ({band.label}) —
          scaled by lean mass when that&rsquo;s tracked, otherwise bodyweight.
          It&rsquo;s an informational range for the Nutrition gauge, not a
          prescription.
        </p>
      </div>
    </div>
  );
}
