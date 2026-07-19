import { describe, expect, it } from "vitest";
import {
  authTokenExpiresAt,
  hashAuthToken,
  ttlForKind,
  INVITE_TTL_MS,
  RESET_TTL_MS,
} from "@/lib/auth-token-crypto";

describe("auth token crypto + TTL (#985)", () => {
  it("hashAuthToken is deterministic and a 64-hex SHA-256", () => {
    const h = hashAuthToken("abc");
    expect(h).toBe(hashAuthToken("abc"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashAuthToken separates distinct tokens (no usable link from the hash)", () => {
    expect(hashAuthToken("token-a")).not.toBe(hashAuthToken("token-b"));
  });

  it("ttlForKind: invite is 24h, reset is 1h", () => {
    expect(ttlForKind("invite")).toBe(INVITE_TTL_MS);
    expect(ttlForKind("reset")).toBe(RESET_TTL_MS);
    expect(INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(RESET_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("authTokenExpiresAt places expiry TTL ms in the future (injected clock)", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(authTokenExpiresAt("reset", now)).toBe(
      new Date(now + RESET_TTL_MS).toISOString()
    );
    expect(authTokenExpiresAt("invite", now)).toBe(
      new Date(now + INVITE_TTL_MS).toISOString()
    );
    // Reset expires strictly before an invite minted at the same instant.
    expect(Date.parse(authTokenExpiresAt("reset", now))).toBeLessThan(
      Date.parse(authTokenExpiresAt("invite", now))
    );
  });
});
