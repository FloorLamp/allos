"use client";

import { IconFlagCheck, IconArrowLeft } from "@tabler/icons-react";
import type { Recap } from "@/lib/session-recap";
import type { WeightUnit } from "@/lib/settings";
import SessionRecapView from "@/components/SessionRecapView";
import IntensityPicker from "./IntensityPicker";
import NotesField from "./NotesField";

// The live-mode "Session complete" step (#924): the flagship finish surface. Shown
// ONLY when Finish is tapped in live mode (the ONLY live-gated renderer) — retro /
// plain-form logging and edits never see it. It reviews the just-worked session
// (recap over the SAME pure sessionRecap the dashboard card + Telegram line use),
// takes a 1-tap session effort (the existing activities.intensity — no new column)
// and notes, then Save. Back returns to the live editor; viewing commits nothing —
// Save stays the finalize.
export default function SessionCompleteStep({
  recap,
  unit,
  intensity,
  onIntensity,
  notes,
  onNotes,
  onBack,
  onSave,
}: {
  recap: Recap;
  unit: WeightUnit;
  intensity: string;
  onIntensity: (v: string) => void;
  notes: string;
  onNotes: (v: string) => void;
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-5" data-testid="session-complete-step">
      <div className="flex items-center gap-2">
        <IconFlagCheck className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Session complete
        </h2>
      </div>

      <div className="rounded-xl border border-black/5 bg-slate-50/60 p-4 dark:border-white/5 dark:bg-ink-900/40">
        <SessionRecapView recap={recap} unit={unit} />
      </div>

      {/* Session effort = the existing activities.intensity (easy/moderate/hard),
          a second surface for the same field (last-write-wins, #467). */}
      <IntensityPicker intensity={intensity} onChange={onIntensity} />

      <NotesField notes={notes} onNotesChange={onNotes} />

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="recap-back"
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-800"
        >
          <IconArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          type="button"
          onClick={onSave}
          data-testid="recap-save"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 active:scale-95"
        >
          Save
        </button>
      </div>
    </div>
  );
}
