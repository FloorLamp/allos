"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AiPrefs } from "@/lib/settings";
import { saveAiSettings } from "./actions";
import SaveStatus from "@/components/SaveStatus";

export default function AiSettings({ prefs }: { prefs: AiPrefs }) {
  const router = useRouter();
  const [autoSuggest, setAutoSuggest] = useState(
    prefs.autoSupplementSuggestions
  );
  const [autoInsights, setAutoInsights] = useState(prefs.autoInsights);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);

  function save(next: { autoSuggest: boolean; autoInsights: boolean }) {
    const fd = new FormData();
    fd.set("auto_supplement_suggestions", next.autoSuggest ? "1" : "0");
    fd.set("auto_insights", next.autoInsights ? "1" : "0");
    startTransition(async () => {
      await saveAiSettings(fd);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">AI</h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={autoSuggest}
            onChange={(e) => {
              const v = e.target.checked;
              setAutoSuggest(v);
              save({ autoSuggest: v, autoInsights });
            }}
            className="h-4 w-4 accent-brand-600"
          />
          Auto-generate supplement suggestions
        </label>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          When a medical document import adds new or out-of-range biomarkers,
          ask the AI for supplement suggestions scoped to them. Generating
          suggestions manually on the Supplements page always works.
        </p>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={autoInsights}
            onChange={(e) => {
              const v = e.target.checked;
              setAutoInsights(v);
              save({ autoSuggest, autoInsights: v });
            }}
            className="h-4 w-4 accent-brand-600"
          />
          Auto-generate insights
        </label>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Not used yet — reserved for automatic insight generation. Insights can
          still be generated manually on the Insights page.
        </p>
      </div>
    </div>
  );
}
