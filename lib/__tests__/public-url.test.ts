import { describe, it, expect } from "vitest";
import { normalizePublicUrl } from "../public-url";

describe("normalizePublicUrl", () => {
  it("allows empty (app not public) and trims to it", () => {
    expect(normalizePublicUrl("")).toEqual({ ok: true, url: "" });
    expect(normalizePublicUrl("   ")).toEqual({ ok: true, url: "" });
  });

  it("accepts a plain https base URL", () => {
    expect(normalizePublicUrl("https://health.example.com")).toEqual({
      ok: true,
      url: "https://health.example.com",
    });
  });

  it("keeps explicit http, ports, and base paths", () => {
    expect(normalizePublicUrl("http://localhost:3000")).toEqual({
      ok: true,
      url: "http://localhost:3000",
    });
    expect(normalizePublicUrl("https://example.com:8443/health")).toEqual({
      ok: true,
      url: "https://example.com:8443/health",
    });
  });

  it("adds https:// when the scheme is missing", () => {
    expect(normalizePublicUrl("health.example.com")).toEqual({
      ok: true,
      url: "https://health.example.com",
    });
  });

  it("strips trailing slashes", () => {
    expect(normalizePublicUrl("https://example.com/")).toEqual({
      ok: true,
      url: "https://example.com",
    });
    expect(normalizePublicUrl("https://example.com/app///")).toEqual({
      ok: true,
      url: "https://example.com/app",
    });
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizePublicUrl("ftp://example.com").ok).toBe(false);
    expect(normalizePublicUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("rejects malformed input, spaces, credentials, query, fragment", () => {
    expect(normalizePublicUrl("https://").ok).toBe(false);
    expect(normalizePublicUrl("not a url").ok).toBe(false);
    expect(normalizePublicUrl("https://user:pw@example.com").ok).toBe(false);
    expect(normalizePublicUrl("https://example.com?x=1").ok).toBe(false);
    expect(normalizePublicUrl("https://example.com#top").ok).toBe(false);
  });
});
