import { describe, it, expect } from "vitest";
import {
  isAiConfigured,
  resolveClientOptions,
  endpointHost,
  endpointLabel,
} from "@/lib/ai-client";

// Pure config-resolution logic for the configurable AI endpoint (issue #43).
// Everything is env-injected so it's testable without instantiating the SDK.

describe("isAiConfigured", () => {
  it("is false with neither key nor base URL", () => {
    expect(isAiConfigured({})).toBe(false);
    expect(isAiConfigured({ ANTHROPIC_API_KEY: "", AI_BASE_URL: "" })).toBe(
      false
    );
  });

  it("is true with just an API key (default hosted endpoint)", () => {
    expect(isAiConfigured({ ANTHROPIC_API_KEY: "sk-ant-xyz" })).toBe(true);
  });

  it("is true with just a base URL (local server that ignores keys)", () => {
    expect(isAiConfigured({ AI_BASE_URL: "http://localhost:11434" })).toBe(
      true
    );
  });

  it("is true with both set", () => {
    expect(
      isAiConfigured({
        ANTHROPIC_API_KEY: "sk-ant-xyz",
        AI_BASE_URL: "http://localhost:11434",
      })
    ).toBe(true);
  });
});

describe("resolveClientOptions", () => {
  it("returns null when AI is not configured", () => {
    expect(resolveClientOptions({})).toBeNull();
  });

  it("passes the real key and no baseURL for the default endpoint", () => {
    expect(resolveClientOptions({ ANTHROPIC_API_KEY: "sk-ant-xyz" })).toEqual({
      apiKey: "sk-ant-xyz",
    });
  });

  it("uses a placeholder key when only a base URL is set (SDK needs non-empty)", () => {
    expect(
      resolveClientOptions({ AI_BASE_URL: "http://localhost:11434" })
    ).toEqual({ apiKey: "local", baseURL: "http://localhost:11434" });
  });

  it("keeps the real key alongside the base URL when both are set", () => {
    expect(
      resolveClientOptions({
        ANTHROPIC_API_KEY: "sk-ant-xyz",
        AI_BASE_URL: "http://localhost:11434",
      })
    ).toEqual({ apiKey: "sk-ant-xyz", baseURL: "http://localhost:11434" });
  });
});

describe("endpointHost", () => {
  it("is undefined for the default endpoint (no base URL)", () => {
    expect(endpointHost({})).toBeUndefined();
    expect(endpointHost({ ANTHROPIC_API_KEY: "sk-ant-xyz" })).toBeUndefined();
  });

  it("returns host only — never path, query, or an embedded credential", () => {
    expect(
      endpointHost({ AI_BASE_URL: "http://localhost:11434/v1?token=secret" })
    ).toBe("localhost:11434");
    expect(
      endpointHost({ AI_BASE_URL: "https://user:pass@ai.internal:8443/v1" })
    ).toBe("ai.internal:8443");
  });

  it("falls back to the raw value for a malformed URL", () => {
    expect(endpointHost({ AI_BASE_URL: "not a url" })).toBe("not a url");
  });
});

describe("endpointLabel", () => {
  it('labels the default endpoint "Anthropic API"', () => {
    expect(endpointLabel({})).toBe("Anthropic API");
    expect(endpointLabel({ ANTHROPIC_API_KEY: "sk-ant-xyz" })).toBe(
      "Anthropic API"
    );
  });

  it("labels a custom endpoint by its host", () => {
    expect(endpointLabel({ AI_BASE_URL: "http://localhost:11434" })).toBe(
      "localhost:11434"
    );
  });
});
