"use client";

import { useRef, useState } from "react";
import { saveTrainingZones } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";

// Training HR-zone settings (issue #159) — PROFILE-scoped, following the active
// profile. A manual max-HR override for people who've tested theirs (it beats the
// age formula) and the weekly Zone 2 minutes target the Trends → Fitness view
// tracks against. Both save on blur, mirroring the smoking-history form.
export default function TrainingZonesForm({
  maxHrOverride,
  zone2Target,
  estimatedMaxHr,
  stepsTarget,
}: {
  maxHrOverride: number | null;
  zone2Target: number;
  estimatedMaxHr: number | null;
  // The declared daily step target (#1723), or null when the profile has none. Null
  // is the honest default: nothing counts steps against a number nobody chose.
  stepsTarget: number | null;
}) {
  const [maxHr, setMaxHr] = useState(
    maxHrOverride == null ? "" : String(maxHrOverride)
  );
  const [target, setTarget] = useState(String(zone2Target));
  const [steps, setSteps] = useState(
    stepsTarget == null ? "" : String(stepsTarget)
  );
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  function save(next: { maxHr: string; target: string; steps: string }) {
    const fd = new FormData();
    fd.set("max_hr_override", next.maxHr);
    fd.set("zone2_weekly_target_min", next.target);
    fd.set("steps_daily_target", next.steps);
    runSave(async () => {
      await saveTrainingZones(fd);
    });
  }

  return (
    <div
      ref={formRef}
      className="card space-y-5"
      data-testid="training-zones-form"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Training heart-rate zones
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label" htmlFor="max-hr-override">
          Max heart rate (override)
        </label>
        <input
          id="max-hr-override"
          data-testid="max-hr-override"
          type="number"
          min={100}
          max={240}
          value={maxHr}
          placeholder={
            estimatedMaxHr != null
              ? `${estimatedMaxHr} (age estimate)`
              : "e.g. 185"
          }
          onChange={(e) => setMaxHr(e.target.value)}
          onBlur={() => save({ maxHr, target, steps })}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          A lab or field-tested max HR beats the age formula (208 − 0.7 × age).
          Leave blank to use the age estimate
          {estimatedMaxHr != null ? ` (${estimatedMaxHr} bpm)` : ""}. A resting
          HR (from your body metrics) switches the zones to the personalized
          Karvonen heart-rate-reserve method.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label" htmlFor="zone2-target">
          Weekly Zone 2 target (minutes)
        </label>
        <input
          id="zone2-target"
          data-testid="zone2-target-input"
          type="number"
          min={0}
          max={5000}
          step={5}
          value={target}
          placeholder="e.g. 150"
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() => save({ maxHr, target, steps })}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The weekly aerobic-base goal the Trends → Fitness zone chart draws its
          target line against. 150 min/week is a common starting point; set 0 to
          hide the target.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label" htmlFor="steps-daily-target">
          Daily step target
        </label>
        <input
          id="steps-daily-target"
          data-testid="steps-daily-target-input"
          type="number"
          min={0}
          max={100000}
          step={500}
          value={steps}
          placeholder="e.g. 8000"
          onChange={(e) => setSteps(e.target.value)}
          onBlur={() => save({ maxHr, target, steps })}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Your own daily step expectation. The morning digest reports yesterday
          against it, and a quiet note appears later in the day when the day is
          well behind. Counted, never escalated — no streaks, no reminders of
          its own. Leave blank (or set 0) for no target.
        </p>
      </div>
    </div>
  );
}
