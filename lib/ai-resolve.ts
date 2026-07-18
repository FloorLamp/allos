// Runtime AI client resolution (issue #875): task class → tier → client. Every AI
// call site resolves its client here instead of building one from the environment,
// so the Heavy/Light split and the arbitrary-provider config take effect everywhere.
//
// This module is deliberately DB-free (it reads the tier configs through the
// boot-injected provider on `lib/ai-client`), so the extraction barrels that import
// it stay loadable in the pure test suite. It calls `createAiClient` from
// `@/lib/ai-client` — the SAME seam the DB-tier tests mock — so a mocked client flows
// straight through the resolver into the real extraction/suggestion orchestration.

import type Anthropic from "@anthropic-ai/sdk";
import {
  createAiClient,
  currentTierConfigs,
  endpointHost,
} from "./ai-client";
import {
  effectiveModel,
  resolveTaskTier,
  type AiTaskClass,
  type ApiShape,
  type TierName,
} from "./ai-tiers";

export interface ResolvedTaskClient {
  client: Anthropic;
  model: string;
  tier: TierName;
  apiShape: ApiShape;
  // The endpoint host for the AI-log `baseUrl` tag (never a full URL/secret).
  // Undefined for the default Anthropic endpoint.
  host?: string;
}

// Resolve the client that will serve a task, or null when no tier is configured (the
// caller then takes its offline-degradation path). Applies the fallback chain
// (light→heavy→null; heavy→null) over the current tier configs.
export function resolveTaskClient(task: AiTaskClass): ResolvedTaskClient | null {
  const resolved = resolveTaskTier(task, currentTierConfigs());
  if (!resolved) return null;
  const { config, tier } = resolved;
  const client = createAiClient({
    apiShape: config.apiShape,
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });
  return {
    client,
    model: effectiveModel(config),
    tier,
    apiShape: config.apiShape,
    host: config.baseUrl ? endpointHost({ AI_BASE_URL: config.baseUrl }) : undefined,
  };
}

// Whether a task can dispatch at all (a tier resolves for it). The per-task-class
// replacement for the old global aiConfigured() — a surface degrades accurately even
// when only one tier is configured (extraction down while narratives run local).
export function isTaskConfigured(task: AiTaskClass): boolean {
  return resolveTaskTier(task, currentTierConfigs()) != null;
}
