"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TierConfigView } from "@/lib/settings/ai-tiers";
import type { ApiShape, TierName } from "@/lib/ai-tiers";
import { saveAiTierConfig, testAiTier } from "./actions";

// The GLOBAL AI provider tiers (issue #875): two independent provider configs, admin
// only. Heavy runs document extraction (vision + long context); Light runs
// narratives, suggestions, coverage blurbs, and free-text mapping. Each tier speaks
// either the Anthropic API or an OpenAI-compatible (chat-completions) endpoint, so a
// self-hoster can pin Heavy to a local vision model and Light to a small one — or
// leave both on the hosted API. The key is write-only, stored like the bot token.
export default function AiTierSettings({
  heavy,
  light,
}: {
  heavy: TierConfigView;
  light: TierConfigView;
}) {
  return (
    <div
      className="card mt-6 max-w-lg space-y-6"
      data-testid="ai-tier-settings"
    >
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          AI providers
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Two tiers, each its own provider. <strong>Heavy</strong> handles
          document extraction and sees your uploaded records — pin it to a local
          endpoint for zero external egress. <strong>Light</strong> handles
          narratives, suggestions, and coverage blurbs; when it&rsquo;s unset it
          falls back to Heavy. With neither configured, every AI feature
          degrades to its offline summary. Backups of <code>data/</code> carry
          these keys, same as the bot token.
        </p>
      </div>

      <TierBlock
        tier="heavy"
        label="Heavy — extraction"
        note="Reads uploaded documents (labs, PDFs, images). Needs a vision-capable model — the test below probes it."
        view={heavy}
      />
      <TierBlock
        tier="light"
        label="Light — narratives & suggestions"
        note="Daily insights, recaps, lab-trend reads, supplement suggestions, coverage blurbs, and free-text symptom mapping. Falls back to Heavy when unset."
        view={light}
      />
    </div>
  );
}

function TierBlock({
  tier,
  label,
  note,
  view,
}: {
  tier: TierName;
  label: string;
  note: string;
  view: TierConfigView;
}) {
  const router = useRouter();
  const [apiShape, setApiShape] = useState<ApiShape>(view.apiShape);
  const [baseUrl, setBaseUrl] = useState(view.baseUrl);
  const [model, setModel] = useState(view.model);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  function buildFormData() {
    const fd = new FormData();
    fd.set("tier", tier);
    fd.set("api_shape", apiShape);
    fd.set("base_url", baseUrl);
    fd.set("model", model);
    fd.set("api_key", apiKey);
    if (clearKey) fd.set("clear_api_key", "1");
    return fd;
  }

  function save() {
    start(async () => {
      try {
        await saveAiTierConfig(buildFormData());
        setResult({ ok: true, message: "Saved." });
        setApiKey("");
        setClearKey(false);
        router.refresh();
      } catch {
        setResult({ ok: false, message: "Couldn't save the tier. Try again." });
      }
    });
  }

  // Test acts on STORED settings, so persist the form first (unsaved edits would be
  // silently ignored), then probe. The try/catch keeps a transient throw off the
  // error boundary.
  function test() {
    start(async () => {
      try {
        await saveAiTierConfig(buildFormData());
        setApiKey("");
        setClearKey(false);
        setResult(await testAiTier(buildFormData()));
        router.refresh();
      } catch {
        setResult({
          ok: false,
          message: "Couldn't reach the endpoint. Try again.",
        });
      }
    });
  }

  const keyPlaceholder = view.hasApiKey
    ? "•••••••• (saved — leave blank to keep)"
    : "Enter API key";

  return (
    <div
      data-testid={`ai-tier-${tier}`}
      className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10"
    >
      <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{note}</p>

      <div>
        <label className="label">API shape</label>
        <select
          data-testid={`ai-tier-${tier}-shape`}
          value={apiShape}
          onChange={(e) => setApiShape(e.target.value as ApiShape)}
          className="input"
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai-compatible">
            OpenAI-compatible (vLLM / Ollama / LM Studio / …)
          </option>
        </select>
      </div>

      <div>
        <label className="label">Base URL</label>
        <input
          type="text"
          data-testid={`ai-tier-${tier}-baseurl`}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={
            apiShape === "openai-compatible"
              ? "http://localhost:11434/v1"
              : "Default Anthropic API (leave blank)"
          }
          className="input"
        />
      </div>

      <div>
        <label className="label">Model</label>
        <input
          type="text"
          data-testid={`ai-tier-${tier}-model`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Default model (leave blank)"
          className="input"
        />
      </div>

      <div>
        <label className="label">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyPlaceholder}
          className="input"
        />
        {view.hasApiKey && (
          <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-600"
            />
            Remove the saved key
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          data-testid={`ai-tier-${tier}-save`}
          className="btn"
        >
          Apply {tier} tier
        </button>
        <button
          type="button"
          onClick={test}
          disabled={pending}
          data-testid={`ai-tier-${tier}-test`}
          className="btn-ghost"
        >
          Test connection
        </button>
      </div>

      {result && (
        <p
          data-testid={`ai-tier-${tier}-result`}
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
