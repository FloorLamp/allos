// DB-backed AI tier provider configs (issue #875). The Heavy/Light tier configs live
// in the global `settings` table (admin-managed on Settings → Server), mirroring the
// Telegram bot token's secrets-in-DB posture. The legacy env vars
// (ANTHROPIC_API_KEY / AI_BASE_URL / HEALTH_AI_MODEL) are DEMOTED to a first-boot
// seed for the Heavy tier and remain the runtime fallback per-field until the DB owns
// a value — so existing deployments are unaffected.
//
// The pure tier vocabulary + resolution logic is lib/ai-tiers.ts; this is the thin DB
// wrapper. lib/db registers getTierConfigs as the runtime provider (see
// lib/ai-client.ts setTierConfigProvider) so lib/ai-resolve stays DB-free.
//
// Every function takes the Database HANDLE instead of importing the `db` singleton
// (#2958), for the same reason lib/migrations/boot-tasks does: lib/db imports this
// module, so importing lib/db back made a runtime cycle in which this module
// evaluated FIRST and saw `db` still in its temporal dead zone. It is also why kv.ts
// is unreachable from here — it hoists a prepared statement over the singleton.
import type Database from "better-sqlite3";
import {
  parseApiShape,
  type TierConfig,
  type TierConfigs,
  type TierName,
} from "../ai-tiers";

function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

function setSetting(db: Database.Database, key: string, value: string): void {
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

function readTier(db: Database.Database, tier: TierName): TierConfig {
  const k = keys(tier);
  const envFor = (field: "shape" | "baseUrl" | "apiKey" | "model") =>
    tier === "heavy" ? heavyEnvDefault(field) : "";
  return {
    apiShape: parseApiShape(getSetting(db, k.shape) ?? envFor("shape")),
    baseUrl: (getSetting(db, k.baseUrl) ?? envFor("baseUrl")).trim(),
    apiKey: getSetting(db, k.apiKey) ?? envFor("apiKey"),
    model: (getSetting(db, k.model) ?? envFor("model")).trim(),
  };
}

// The current tier configs from the DB, with the Heavy env fallback baked in. This is
// the function registered as the runtime provider on lib/ai-client.
export function getTierConfigs(db: Database.Database): TierConfigs {
  return { heavy: readTier(db, "heavy"), light: readTier(db, "light") };
}

export function getTierConfig(
  db: Database.Database,
  tier: TierName
): TierConfig {
  return readTier(db, tier);
}

// Persist one tier's config. An empty api key is treated as "leave the stored key
// unchanged" so a masked/write-only key field (which submits blank when untouched)
// never wipes a saved secret; pass a sentinel clear separately when needed.
// `.immediate()` is the BEGIN IMMEDIATE writeTx takes. The #468 guard exempts this
// file wholesale, so dropping it here would not be caught — keep it by hand.
export function setTierConfig(
  db: Database.Database,
  tier: TierName,
  cfg: {
    apiShape: TierConfig["apiShape"];
    baseUrl: string;
    model: string;
    apiKey?: string;
  }
): void {
  const k = keys(tier);
  db.transaction(() => {
    setSetting(db, k.shape, cfg.apiShape);
    setSetting(db, k.baseUrl, cfg.baseUrl.trim());
    setSetting(db, k.model, cfg.model.trim());
    if (cfg.apiKey !== undefined && cfg.apiKey !== "") {
      setSetting(db, k.apiKey, cfg.apiKey);
    }
  }).immediate();
}

// Clear a tier's stored API key (the "remove key" affordance).
export function clearTierApiKey(db: Database.Database, tier: TierName): void {
  setSetting(db, keys(tier).apiKey, "");
}

// A key/endpoint-free view of a tier for the admin UI: never returns the stored API
// key (write-only display), only whether one is set. Mirrors the bot-token posture.
export interface TierConfigView {
  apiShape: TierConfig["apiShape"];
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export function getTierConfigView(
  db: Database.Database,
  tier: TierName
): TierConfigView {
  const cfg = readTier(db, tier);
  return {
    apiShape: cfg.apiShape,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasApiKey: Boolean(cfg.apiKey),
  };
}
