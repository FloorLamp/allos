"use client";

import { saveAnxietyScaleOptIn } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The check-in "Calm" (anxiety) scale opt-in (issue #1313, signal 6). The daily
// anxiety rating on the "How are you today?" card is relevance-gated — it appears on
// its own for a profile engaging with the mental-health domain (a GAD-7/PHQ-9 on
// record, an anxiety condition or medication, a protocol tracking it, or any prior
// use of the scale). This toggle is the explicit escape hatch for a profile with no
// inferable signal who nonetheless wants the daily rating. Off by default. Saves on
// change (the #794 Settings autosave-on-change pattern).
export default function AnxietyScaleForm({ enabled }: { enabled: boolean }) {
  const { status, value: on, save: runSave } = useSaveStatus(enabled);

  function save(next: boolean) {
    const fd = new FormData();
    fd.set("anxiety_scale_enabled", next ? "1" : "0");
    runSave(next, async () => {
      await saveAnxietyScaleOptIn(fd);
    });
  }

  return (
    <div className="card space-y-3" data-testid="anxiety-scale-form">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Daily check-in scales
        </h2>
        <SaveStatus {...status} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          data-testid="anxiety-scale-enabled"
          onChange={(e) => save(e.target.checked)}
        />
        <span>
          Show the “Calm” (anxiety) rating in the daily check-in.
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            The daily anxiety rating already appears when it’s relevant to you.
            Turn this on to always show it — a continuous signal between
            clinical check-ins. Energy always shows.
          </span>
        </span>
      </label>
    </div>
  );
}
