"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AiPrefs } from "@/lib/settings";
import type { AiEndpointInfo } from "@/lib/ai-client";
import { saveAiSettings } from "./server/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

export default function AiSettings({
  prefs,
  endpoint,
}: {
  prefs: AiPrefs;
  endpoint: AiEndpointInfo;
}) {
  const router = useRouter();
  const [autoSuggest, setAutoSuggest] = useState(
    prefs.autoSupplementSuggestions
  );
  const [maxRuns, setMaxRuns] = useState(prefs.recommendationMaxRunsPerDay);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

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
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">AI</h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      {/*
        Read-only view of the active AI backend (issue #43). Endpoint and model
        are env-driven (AI_BASE_URL / HEALTH_AI_MODEL) rather than editable in
        the UI — that keeps the config cheap and avoids storing an endpoint (and
        any embedded credential) in the DB. No external calls happen beyond the
        endpoint shown here.
      */}
      <dl
        data-testid="ai-endpoint-info"
        className="rounded-md border border-black/10 bg-black/[0.02] p-3 text-xs dark:border-white/10 dark:bg-white/[0.03]"
      >
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Endpoint</dt>
          <dd className="font-medium text-slate-700 dark:text-slate-200">
            {endpoint.label}
          </dd>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Model</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-200">
            {endpoint.model}
          </dd>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Status</dt>
          <dd className="font-medium text-slate-700 dark:text-slate-200">
            {endpoint.configured ? "Configured" : "Not configured (offline)"}
          </dd>
        </div>
        <p className="mt-2 text-slate-500 dark:text-slate-400">
          Set via environment (<code>AI_BASE_URL</code>,{" "}
          <code>HEALTH_AI_MODEL</code>). Point <code>AI_BASE_URL</code> at a
          local inference server for zero external egress; no requests leave the
          server beyond this endpoint.
        </p>
      </dl>

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
