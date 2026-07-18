// DB-backed AI tier provider configs (issue #875). The Heavy/Light tier configs live
// in the global `settings` table (admin-managed on Settings → Server), mirroring the
// Telegram bot token's secrets-in-DB posture. The legacy env vars
// (ANTHROPIC_API_KEY / AI_BASE_URL / HEALTH_AI_MODEL) are DEMOTED to a first-boot
// seed for the Heavy tier and remain the runtime fallback per-field until the DB owns
// a value — so existing deployments are unaffected.
//
// The pure tier vocabulary + resolution logic is lib/ai-tiers.ts; this is the thin DB
// wrapper. The boot task registers getTierConfigs as the runtime provider (see
// lib/ai-client.ts setTierConfigProvider) so lib/ai-resolve stays DB-free.

import { writeTx } from "../db";
import { getSetting, setSetting } from "./kv";
import {
  parseApiShape,
  type TierConfig,
  type TierConfigs,
  type TierName,
} from "../ai-tiers";

// Setting keys per tier. Kept mechanical (`ai_<tier>_<field>`) so the read/write/seed
// paths never drift.
function keys(tier: TierName) {
  return {
    shape: `ai_${tier}_shape`,
    baseUrl: `ai_${tier}_base_url`,
    apiKey: `ai_${tier}_api_key`,
    model: `ai_${tier}_model`,
  };
}

// The Heavy tier's per-field env fallback (the demoted legacy vars). Light has none —
// an unconfigured Light tier falls back to Heavy at resolution time.
function heavyEnvDefault(field: "shape" | "baseUrl" | "apiKey" | "model"): string {
  switch (field) {
    case "baseUrl":
      return process.env.AI_BASE_URL || "";
    case "apiKey":
      return process.env.ANTHROPIC_API_KEY || "";
    case "model":
      return process.env.HEALTH_AI_MODEL || "";
    case "shape":
      return "anthropic";
  }
}

function readTier(tier: TierName): TierConfig {
  const k = keys(tier);
  const envFor = (field: "shape" | "baseUrl" | "apiKey" | "model") =>
    tier === "heavy" ? heavyEnvDefault(field) : "";
  return {
    apiShape: parseApiShape(getSetting(k.shape) ?? envFor("shape")),
    baseUrl: (getSetting(k.baseUrl) ?? envFor("baseUrl")).trim(),
    apiKey: getSetting(k.apiKey) ?? envFor("apiKey"),
    model: (getSetting(k.model) ?? envFor("model")).trim(),
  };
}

// The current tier configs from the DB, with the Heavy env fallback baked in. This is
// the function registered as the runtime provider on lib/ai-client.
export function getTierConfigs(): TierConfigs {
  return { heavy: readTier("heavy"), light: readTier("light") };
}

export function getTierConfig(tier: TierName): TierConfig {
  return readTier(tier);
}

// Persist one tier's config. An empty api key is treated as "leave the stored key
// unchanged" so a masked/write-only key field (which submits blank when untouched)
// never wipes a saved secret; pass a sentinel clear separately when needed.
export function setTierConfig(
  tier: TierName,
  cfg: { apiShape: TierConfig["apiShape"]; baseUrl: string; model: string; apiKey?: string }
): void {
  const k = keys(tier);
  writeTx(() => {
    setSetting(k.shape, cfg.apiShape);
    setSetting(k.baseUrl, cfg.baseUrl.trim());
    setSetting(k.model, cfg.model.trim());
    if (cfg.apiKey !== undefined && cfg.apiKey !== "") {
      setSetting(k.apiKey, cfg.apiKey);
    }
  });
}

// Clear a tier's stored API key (the "remove key" affordance).
export function clearTierApiKey(tier: TierName): void {
  setSetting(keys(tier).apiKey, "");
}

// Whether the Heavy tier has ANY stored setting yet (used by the seed to decide
// first-boot). Reads the raw settings, not the env-merged view.
function heavyHasStoredConfig(): boolean {
  const k = keys("heavy");
  return (
    getSetting(k.shape) !== undefined ||
    getSetting(k.baseUrl) !== undefined ||
    getSetting(k.apiKey) !== undefined ||
    getSetting(k.model) !== undefined
  );
}

// First-boot seed: persist the legacy env vars onto the Heavy tier ONCE, when nothing
// is stored yet AND the env actually carries AI config. Idempotent — never overwrites
// a value the admin has since set (the seedTimezoneFromEnv pattern). A fresh instance
// with no AI env leaves both tiers unset (offline degradation, unchanged).
export function seedAiTiersFromEnv(): void {
  if (heavyHasStoredConfig()) return;
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const baseUrl = process.env.AI_BASE_URL || "";
  const model = process.env.HEALTH_AI_MODEL || "";
  if (!apiKey && !baseUrl && !model) return; // nothing to seed
  const k = keys("heavy");
  writeTx(() => {
    setSetting(k.shape, "anthropic");
    setSetting(k.baseUrl, baseUrl.trim());
    setSetting(k.apiKey, apiKey);
    setSetting(k.model, model.trim());
  });
}

// A key/endpoint-free view of a tier for the admin UI: never returns the stored API
// key (write-only display), only whether one is set. Mirrors the bot-token posture.
export interface TierConfigView {
  apiShape: TierConfig["apiShape"];
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export function getTierConfigView(tier: TierName): TierConfigView {
  const cfg = readTier(tier);
  return {
    apiShape: cfg.apiShape,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasApiKey: Boolean(cfg.apiKey),
  };
}
