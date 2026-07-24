// AI provider TIERS — the pure substrate (issue #875). No DB, no SDK, no network:
// just the tier vocabulary, the task→tier mapping table, and the fallback-chain
// resolution logic, so all of it is unit-testable in the pure suite.
//
// Two tiers, each an independent provider config:
//   - Heavy — document/workout extraction (vision + long-context; quality-critical,
//     PHI-heavy). Seeded from the legacy env vars on first boot.
//   - Light — narratives, suggestions, coverage blurbs, free-text symptom mapping,
//     finding explainers (the cheap, high-volume tasks).
//
// `api_shape` is the real unlock for "arbitrary APIs/models": `anthropic` uses the
// Anthropic SDK path; `openai-compatible` covers vLLM/Ollama/LM Studio/OpenRouter/…
// via the chat-completions shape (lib/ai-openai-shim.ts).
//
// The DB-backed config read + persistence lives in lib/settings/ai-tiers.ts; the
// runtime client resolution lives in lib/ai-resolve.ts. Both consume this module.

export type TierName = "heavy" | "light";

export type ApiShape = "anthropic" | "openai-compatible";

// The default model when a tier names none (the historical HEALTH_AI_MODEL default).
// A plain config value, never attribution.
export const DEFAULT_AI_MODEL = "claude-sonnet-5";

// One tier's provider config. Empty strings mean "unset": an empty baseUrl uses the
// provider's default endpoint (Anthropic's hosted API), an empty model falls back to
// DEFAULT_AI_MODEL, and an empty apiKey is tolerated when a baseUrl is set (local
// inference servers ignore the key).
export interface TierConfig {
  apiShape: ApiShape;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TierConfigs {
  heavy: TierConfig;
  light: TierConfig;
}

// An empty (unset) tier — the light default and the not-configured heavy state.
export function emptyTierConfig(): TierConfig {
  return { apiShape: "anthropic", baseUrl: "", apiKey: "", model: "" };
}

// The task classes that consume AI. Each maps to a tier via TASK_TIER below. Kept a
// small closed union (mirroring the ReasonCode / AiFeature discipline) so a new AI
// consumer declares its tier here deliberately, and the mapping stays enumerable.
export type AiTaskClass =
  // Medical + workout document extraction (vision, long context). Heavy.
  | "extraction"
  // The daily coaching insight narrative. Light.
  | "insight"
  // Weekly/monthly recap + lab-trend interpretation. Light.
  | "narrative"
  // The coverage-gap descriptive blurb (#550). Light.
  | "coverage"
  // Supplement suggestions (incl. auto-suggest). Light.
  | "suggestions"
  // Free-text symptom mapping onto the vocabulary (#877). Light.
  | "symptom-map"
  // "Why is this flagged?" narration over the reason model (#878, Phase 1). Light.
  | "explain"
  // Grounded record Q&A over the profile's OWN retrieved rows (#878, Phase 2): a
  // bounded retrieval (capped citation set) narrated with links. Light — the retrieval
  // is capped, so it never needs long-context Heavy.
  | "ask";

export const AI_TASK_CLASSES: readonly AiTaskClass[] = [
  "extraction",
  "insight",
  "narrative",
  "coverage",
  "suggestions",
  "symptom-map",
  "explain",
  "ask",
] as const;

// The task→tier mapping table (exported + unit-tested). Extensible to per-task
// provider overrides later WITHOUT a schema change — store per-task keys, absent =
// tier default — but today every task takes its tier's config.
export const TASK_TIER: Record<AiTaskClass, TierName> = {
  extraction: "heavy",
  insight: "light",
  narrative: "light",
  coverage: "light",
  suggestions: "light",
  "symptom-map": "light",
  explain: "light",
  ask: "light",
};

// Tasks that require an image-capable (vision) model. Extraction reads PDFs/images;
// a tier pinned to a blind model must not silently serve it (the settings probe
// surfaces the warning, and the extractor refuses rather than emitting garbage).
const VISION_TASKS: ReadonlySet<AiTaskClass> = new Set<AiTaskClass>([
  "extraction",
]);

export function taskNeedsVision(task: AiTaskClass): boolean {
  return VISION_TASKS.has(task);
}

// Normalize a stored/submitted shape string to the closed union (default anthropic).
export function parseApiShape(v: string | undefined | null): ApiShape {
  return v === "openai-compatible" ? "openai-compatible" : "anthropic";
}

// A tier can dispatch when it has EITHER an API key OR a custom base URL — the same
// predicate as the legacy isAiConfigured (a local server ignores the key, so a base
// URL alone is enough). An empty model is fine (resolution fills DEFAULT_AI_MODEL).
export function tierConfigured(cfg: TierConfig | null | undefined): boolean {
  if (!cfg) return false;
  return Boolean(cfg.apiKey.trim() || cfg.baseUrl.trim());
}

export interface ResolvedTier {
  tier: TierName;
  config: TierConfig;
}

// The explicit fallback chain (issue #875):
//   Light task, light unconfigured  → falls back to Heavy.
//   Heavy task (or fell back), heavy unconfigured → null (offline degradation).
//   Nothing configured → null.
// Returns the tier that will actually serve the task, or null when neither can.
export function resolveTaskTier(
  task: AiTaskClass,
  configs: TierConfigs
): ResolvedTier | null {
  const want = TASK_TIER[task];
  if (want === "light") {
    if (tierConfigured(configs.light))
      return { tier: "light", config: configs.light };
    if (tierConfigured(configs.heavy))
      return { tier: "heavy", config: configs.heavy };
    return null;
  }
  // Heavy task: no fallback below heavy — extraction on a light model would misroute
  // a vision/long-context job, so it degrades to offline instead.
  if (tierConfigured(configs.heavy))
    return { tier: "heavy", config: configs.heavy };
  return null;
}

// The model a resolved tier will call (its configured model, or the default).
export function effectiveModel(config: TierConfig): string {
  return config.model.trim() || DEFAULT_AI_MODEL;
}
