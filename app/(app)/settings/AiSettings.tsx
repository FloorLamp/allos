"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AiPrefs } from "@/lib/settings";
import { saveAiSettings } from "./server/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";

export default function AiSettings({ prefs }: { prefs: AiPrefs }) {
  const router = useRouter();
  const [autoSuggest, setAutoSuggest] = useState(
    prefs.autoSupplementSuggestions
  );
  const [maxRuns, setMaxRuns] = useState(prefs.recommendationMaxRunsPerDay);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  function save(next: { autoSuggest: boolean; maxRuns: number }) {
    const fd = new FormData();
    fd.set("auto_supplement_suggestions", next.autoSuggest ? "1" : "0");
    fd.set("recommendation_max_runs_per_day", String(next.maxRuns));
    runSave(async () => {
      await saveAiSettings(fd);
      router.refresh();
    });
  }

  return (
    <div ref={formRef} className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          AI automation
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Configure the AI providers themselves — the Heavy and Light tiers — in
        the AI providers card above.
      </p>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={autoSuggest}
            onChange={(e) => {
              const v = e.target.checked;
              setAutoSuggest(v);
              save({ autoSuggest: v, maxRuns });
            }}
            className="h-4 w-4 accent-brand-600"
          />
          Auto-generate supplement suggestions
        </label>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          When a medical document import adds new or out-of-range biomarkers,
          run an AI recommendation scoped to them. Generating suggestions
          manually on the Supplements page always works.
        </p>
      </div>

      <div>
        <label
          htmlFor="recommendation-max-runs"
          className="block text-sm font-medium text-slate-700 dark:text-slate-200"
        >
          Max recommendation runs per profile per day
        </label>
        <input
          id="recommendation-max-runs"
          data-testid="recommendation-max-runs"
          type="number"
          min={1}
          max={24}
          value={maxRuns}
          onChange={(e) => setMaxRuns(Number(e.target.value))}
          onBlur={() => save({ autoSuggest, maxRuns })}
          className="mt-1 w-24 rounded-md border border-black/10 bg-white px-2 py-1 text-sm dark:border-white/10 dark:bg-ink-900"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The ceiling on cadence-driven AI runs (supplement suggestions + daily
          insight) for any one profile in a day. Scheduled cadence already caps
          at one run per day; this backstops upload/manual bursts. Set each
          profile’s cadence on its Profile tab.
        </p>
      </div>
    </div>
  );
}
