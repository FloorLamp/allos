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
  const [autoInsights, setAutoInsights] = useState(prefs.autoInsights);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: { autoSuggest: boolean; autoInsights: boolean }) {
    const fd = new FormData();
    fd.set("auto_supplement_suggestions", next.autoSuggest ? "1" : "0");
    fd.set("auto_insights", next.autoInsights ? "1" : "0");
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
          <dt className="text-slate-400 dark:text-slate-500">Endpoint</dt>
          <dd className="font-medium text-slate-700 dark:text-slate-200">
            {endpoint.label}
          </dd>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <dt className="text-slate-400 dark:text-slate-500">Model</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-200">
            {endpoint.model}
          </dd>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <dt className="text-slate-400 dark:text-slate-500">Status</dt>
          <dd className="font-medium text-slate-700 dark:text-slate-200">
            {endpoint.configured ? "Configured" : "Not configured (offline)"}
          </dd>
        </div>
        <p className="mt-2 text-slate-400 dark:text-slate-500">
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
