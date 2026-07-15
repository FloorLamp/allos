// PURE TIER (npm test) — issue #675.
//
// The env-injected resolution helpers (isAiConfigured / resolveClientOptions /
// endpointHost / endpointLabel) are covered by ai-client-config.test.ts. This pins
// the RUNTIME wrappers that read process.env directly and build the real SDK client
// — the "client-construction matrix" ask: no-config throws (the degraded path's
// backstop), a key builds a default-endpoint client, and an AI_BASE_URL override is
// honored on the constructed client. Constructing the SDK is offline (no request is
// made), so this stays a pure test.

import { describe, it, expect, afterEach } from "vitest";
import {
  aiConfigured,
  createAiClient,
  aiEndpointInfo,
  AI_MODEL,
} from "@/lib/ai-client";

const saved = {
  key: process.env.ANTHROPIC_API_KEY,
  base: process.env.AI_BASE_URL,
};

function setEnv(key?: string, base?: string) {
  if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  if (base === undefined) delete process.env.AI_BASE_URL;
  else process.env.AI_BASE_URL = base;
}

afterEach(() => {
  setEnv(saved.key, saved.base);
});

describe("aiConfigured (runtime, reads process.env)", () => {
  it("is false with neither key nor base URL", () => {
    setEnv(undefined, undefined);
    expect(aiConfigured()).toBe(false);
  });
  it("is true with a key", () => {
    setEnv("sk-ant-test", undefined);
    expect(aiConfigured()).toBe(true);
  });
  it("is true with only a base URL (local server)", () => {
    setEnv(undefined, "http://localhost:11434");
    expect(aiConfigured()).toBe(true);
  });
});

describe("createAiClient (runtime)", () => {
  it("throws on the unconfigured backstop path", () => {
    setEnv(undefined, undefined);
    expect(() => createAiClient()).toThrow(/not configured/i);
  });

  it("builds a default-endpoint client from a key", () => {
    setEnv("sk-ant-test", undefined);
    const client = createAiClient();
    // Default Anthropic host — no AI_BASE_URL override.
    expect(client.baseURL).toMatch(/anthropic\.com/);
  });

  it("honors the AI_BASE_URL override on the constructed client", () => {
    setEnv(undefined, "http://localhost:11434");
    const client = createAiClient();
    expect(client.baseURL).toBe("http://localhost:11434");
  });
});

describe("aiEndpointInfo (runtime snapshot)", () => {
  it("reports degraded/offline shape when unconfigured", () => {
    setEnv(undefined, undefined);
    const info = aiEndpointInfo();
    expect(info.configured).toBe(false);
    expect(info.label).toBe("Anthropic API");
    expect(info.host).toBeUndefined();
    expect(info.model).toBe(AI_MODEL);
  });

  it("names a custom endpoint by host (never the raw URL/secret)", () => {
    setEnv("sk-ant-test", "https://user:pass@ai.internal:8443/v1");
    const info = aiEndpointInfo();
    expect(info.configured).toBe(true);
    expect(info.host).toBe("ai.internal:8443");
    expect(info.label).toBe("ai.internal:8443");
  });
});
