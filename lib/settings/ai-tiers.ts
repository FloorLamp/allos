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

// NOTE: this module is on the boot path (boot-tasks registers getTierConfigs as the
// runtime tier provider), so it must NOT import lib/settings/kv — kv hoists a prepared
// statement at module scope that needs the `db` singleton fully assigned, and pulling
// it into the createDb() import chain evaluates it too early (the same reason the boot
// tasks read settings inline). We reference `db` only INSIDE functions (call time,
// when it's ready) and prepare statements lazily.
import { db, writeTx } from "../db";
import {
  parseApiShape,
  type TierConfig,
  type TierConfigs,
  type TierName,
} from "../ai-tiers";

function getSetting(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

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
function heavyEnvDefault(
  field: "shape" | "baseUrl" | "apiKey" | "model"
): string {
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
  cfg: {
    apiShape: TierConfig["apiShape"];
    baseUrl: string;
    model: string;
    apiKey?: string;
  }
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
