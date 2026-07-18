// DB INTEGRATION TIER (npm run test:db) — AI provider tiers, DB-backed (issue #875).
//
// Exercises the settings-backed tier configs + the runtime resolver end to end
// against a real (in-memory) SQLite handle: the env→settings fallback, persistence
// that doesn't wipe a stored key on a blank submit, the seed's first-boot idempotence,
// and resolveTaskClient routing a task to the tier that will actually serve it.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import {
  getTierConfigs,
  getTierConfig,
  setTierConfig,
  clearTierApiKey,
  getTierConfigView,
} from "@/lib/settings/ai-tiers";
import { seedAiTiersFromEnv } from "@/lib/migrations/boot-tasks";
import { resolveTaskClient, isTaskConfigured } from "@/lib/ai-resolve";

const AI_KEYS = [
  "ai_heavy_shape",
  "ai_heavy_base_url",
  "ai_heavy_api_key",
  "ai_heavy_model",
  "ai_light_shape",
  "ai_light_base_url",
  "ai_light_api_key",
  "ai_light_model",
];

function clearAiSettings() {
  const stmt = db.prepare("DELETE FROM settings WHERE key = ?");
  for (const k of AI_KEYS) stmt.run(k);
}

const savedEnv = {
  key: process.env.ANTHROPIC_API_KEY,
  base: process.env.AI_BASE_URL,
  model: process.env.HEALTH_AI_MODEL,
};
function setEnv(key?: string, base?: string, model?: string) {
  for (const [name, val] of [
    ["ANTHROPIC_API_KEY", key],
    ["AI_BASE_URL", base],
    ["HEALTH_AI_MODEL", model],
  ] as const) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
}

beforeEach(() => {
  clearAiSettings();
  setEnv(undefined, undefined, undefined);
});

afterAll(() => {
  clearAiSettings();
  setEnv(savedEnv.key, savedEnv.base, savedEnv.model);
});

describe("getTierConfigs — env fallback + settings override", () => {
  it("falls the Heavy tier back to the legacy env vars when unset in the DB", () => {
    setEnv("sk-env", "", "env-model");
    const { heavy, light } = getTierConfigs();
    expect(heavy.apiKey).toBe("sk-env");
    expect(heavy.model).toBe("env-model");
    // Light has no env fallback — an unconfigured Light tier falls back to Heavy at
    // resolution time, not here.
    expect(light.apiKey).toBe("");
  });

  it("prefers a stored Heavy config over the env", () => {
    setEnv("sk-env", "", "env-model");
    setTierConfig("heavy", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "db-model",
      apiKey: "sk-db",
    });
    const { heavy } = getTierConfigs();
    expect(heavy.apiKey).toBe("sk-db");
    expect(heavy.model).toBe("db-model");
  });
});

describe("setTierConfig — a blank key never wipes a stored secret", () => {
  it("keeps the stored key when the model/url are edited with a blank key field", () => {
    setTierConfig("light", {
      apiShape: "openai-compatible",
      baseUrl: "http://local:8000/v1",
      model: "llama",
      apiKey: "secret-key",
    });
    // Re-save the same tier with a BLANK key (the masked field submits blank when
    // untouched) but a changed model.
    setTierConfig("light", {
      apiShape: "openai-compatible",
      baseUrl: "http://local:8000/v1",
      model: "llama-2",
      apiKey: "",
    });
    expect(getTierConfig("light").apiKey).toBe("secret-key");
    expect(getTierConfig("light").model).toBe("llama-2");
    // The view never leaks the key, only whether one is set.
    const view = getTierConfigView("light");
    expect(view).not.toHaveProperty("apiKey");
    expect(view.hasApiKey).toBe(true);
  });

  it("clearTierApiKey removes the stored secret", () => {
    setTierConfig("light", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "m",
      apiKey: "secret",
    });
    clearTierApiKey("light");
    expect(getTierConfig("light").apiKey).toBe("");
    expect(getTierConfigView("light").hasApiKey).toBe(false);
  });
});

describe("seedAiTiersFromEnv — first-boot idempotence", () => {
  it("seeds Heavy from env once, then never overwrites an admin edit", () => {
    setEnv("sk-seed", "", "seed-model");
    seedAiTiersFromEnv(db);
    expect(getTierConfig("heavy").apiKey).toBe("sk-seed");

    // Admin changes the key; a later boot must not clobber it back to the env.
    setTierConfig("heavy", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "seed-model",
      apiKey: "sk-admin",
    });
    seedAiTiersFromEnv(db);
    expect(getTierConfig("heavy").apiKey).toBe("sk-admin");
  });

  it("seeds nothing when the AI env is entirely empty", () => {
    setEnv(undefined, undefined, undefined);
    seedAiTiersFromEnv(db);
    expect(getTierConfig("heavy").apiKey).toBe("");
    expect(isTaskConfigured("extraction")).toBe(false);
  });
});

describe("resolveTaskClient — task → tier routing", () => {
  it("routes a light task to the Light tier when configured", () => {
    setTierConfig("heavy", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "heavy-model",
      apiKey: "sk-heavy",
    });
    setTierConfig("light", {
      apiShape: "openai-compatible",
      baseUrl: "http://local:8000/v1",
      model: "local-light",
      apiKey: "",
    });
    const r = resolveTaskClient("narrative");
    expect(r?.tier).toBe("light");
    expect(r?.apiShape).toBe("openai-compatible");
    expect(r?.model).toBe("local-light");
    expect(r?.host).toBe("local:8000");
  });

  it("falls a light task back to Heavy when Light is unconfigured", () => {
    setTierConfig("heavy", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "heavy-model",
      apiKey: "sk-heavy",
    });
    const r = resolveTaskClient("symptom-map");
    expect(r?.tier).toBe("heavy");
    expect(r?.model).toBe("heavy-model");
  });

  it("never routes extraction to the Light tier (misroute guard)", () => {
    setTierConfig("light", {
      apiShape: "anthropic",
      baseUrl: "",
      model: "light",
      apiKey: "sk-light",
    });
    expect(resolveTaskClient("extraction")).toBeNull();
    expect(isTaskConfigured("extraction")).toBe(false);
    // …but a light task IS served by the light tier here.
    expect(isTaskConfigured("insight")).toBe(true);
  });

  it("returns null for every task when nothing is configured", () => {
    expect(resolveTaskClient("narrative")).toBeNull();
    expect(resolveTaskClient("extraction")).toBeNull();
  });
});
