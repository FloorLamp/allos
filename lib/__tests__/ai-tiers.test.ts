// PURE TIER (npm test) — AI provider tiers substrate (issue #875).
//
// Pins the task→tier mapping table, the tier-configured predicate, and the explicit
// fallback chain (light→heavy→null; heavy→null). No DB/network — the resolution logic
// is a pure function over two tier configs.

import { describe, it, expect } from "vitest";
import {
  AI_TASK_CLASSES,
  DEFAULT_AI_MODEL,
  TASK_TIER,
  effectiveModel,
  emptyTierConfig,
  parseApiShape,
  resolveTaskTier,
  taskNeedsVision,
  tierConfigured,
  type TierConfig,
  type TierConfigs,
} from "@/lib/ai-tiers";

function cfg(over: Partial<TierConfig> = {}): TierConfig {
  return { ...emptyTierConfig(), ...over };
}
function configs(
  heavy: Partial<TierConfig>,
  light: Partial<TierConfig>
): TierConfigs {
  return { heavy: cfg(heavy), light: cfg(light) };
}

describe("task→tier mapping table", () => {
  it("maps extraction to heavy and everything else to light", () => {
    expect(TASK_TIER.extraction).toBe("heavy");
    expect(TASK_TIER.insight).toBe("light");
    expect(TASK_TIER.narrative).toBe("light");
    expect(TASK_TIER.coverage).toBe("light");
    expect(TASK_TIER.suggestions).toBe("light");
    expect(TASK_TIER["symptom-map"]).toBe("light");
    expect(TASK_TIER.explain).toBe("light");
  });

  it("has a tier for every declared task class", () => {
    for (const task of AI_TASK_CLASSES) {
      expect(TASK_TIER[task]).toMatch(/^(heavy|light)$/);
    }
  });

  it("only extraction requires vision", () => {
    expect(taskNeedsVision("extraction")).toBe(true);
    for (const task of AI_TASK_CLASSES.filter((t) => t !== "extraction")) {
      expect(taskNeedsVision(task)).toBe(false);
    }
  });
});

describe("tierConfigured", () => {
  it("is false for an empty tier", () => {
    expect(tierConfigured(emptyTierConfig())).toBe(false);
    expect(tierConfigured(null)).toBe(false);
  });
  it("is true with an API key", () => {
    expect(tierConfigured(cfg({ apiKey: "sk-x" }))).toBe(true);
  });
  it("is true with only a base URL (local server ignores the key)", () => {
    expect(tierConfigured(cfg({ baseUrl: "http://localhost:11434" }))).toBe(
      true
    );
  });
});

describe("resolveTaskTier — fallback chain", () => {
  it("serves a light task from the light tier when configured", () => {
    const r = resolveTaskTier(
      "narrative",
      configs({ apiKey: "heavy" }, { apiKey: "light" })
    );
    expect(r).toEqual({ tier: "light", config: cfg({ apiKey: "light" }) });
  });

  it("falls a light task back to heavy when light is unconfigured", () => {
    const r = resolveTaskTier("insight", configs({ apiKey: "heavy" }, {}));
    expect(r?.tier).toBe("heavy");
  });

  it("serves an extraction (heavy) task from the heavy tier", () => {
    const r = resolveTaskTier(
      "extraction",
      configs({ apiKey: "heavy" }, { apiKey: "light" })
    );
    expect(r?.tier).toBe("heavy");
  });

  it("never routes a heavy task to the light tier (extraction misroute guard)", () => {
    const r = resolveTaskTier("extraction", configs({}, { apiKey: "light" }));
    expect(r).toBeNull();
  });

  it("returns null when nothing is configured (offline degradation)", () => {
    expect(resolveTaskTier("narrative", configs({}, {}))).toBeNull();
    expect(resolveTaskTier("extraction", configs({}, {}))).toBeNull();
  });
});

describe("effectiveModel / parseApiShape", () => {
  it("falls back to the default model when none is set", () => {
    expect(effectiveModel(cfg({}))).toBe(DEFAULT_AI_MODEL);
    expect(effectiveModel(cfg({ model: "  " }))).toBe(DEFAULT_AI_MODEL);
    expect(effectiveModel(cfg({ model: "local-llm" }))).toBe("local-llm");
  });
  it("normalizes the api shape to the closed union", () => {
    expect(parseApiShape("openai-compatible")).toBe("openai-compatible");
    expect(parseApiShape("anthropic")).toBe("anthropic");
    expect(parseApiShape("garbage")).toBe("anthropic");
    expect(parseApiShape(undefined)).toBe("anthropic");
  });
});
