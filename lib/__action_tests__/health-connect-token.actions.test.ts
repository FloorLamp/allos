// SERVER-ACTION TIER (#1209) — the Health Connect ingest-token write path. The
// action mints/rotates the token, returns the plaintext EXACTLY ONCE, and stores
// only its SHA-256 (never the plaintext). Gated by requireWriteAccess, so a
// read-only acting session is refused.

import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  connectHealthConnect,
  disconnect,
} from "@/app/(app)/integrations/health-connect/actions";
import {
  getConnection,
  resolveHealthConnectProfile,
} from "@/lib/integrations/connections";
import { actAs, createLogin, createProfile } from "./harness";

function config(profileId: number): Record<string, unknown> {
  const conn = getConnection(profileId, "health-connect");
  return conn?.config ? JSON.parse(conn.config) : {};
}

describe("connectHealthConnect / disconnect (#1209)", () => {
  it("returns the plaintext once, stores only the hash, and resolves the token", async () => {
    const login = createLogin();
    const profile = createProfile("hc-token", login.id);
    actAs(login, profile);

    const res = await connectHealthConnect("never");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.token;
    expect(token.length).toBeGreaterThan(10);

    const cfg = config(profile.id);
    // No plaintext at rest — only the SHA-256.
    expect(cfg.token).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain(token);
    expect(cfg.tokenHash).toBe(
      crypto.createHash("sha256").update(token).digest("hex")
    );
    // The returned plaintext resolves back to this profile by hash.
    expect(resolveHealthConnectProfile(token)).toBe(profile.id);
  });

  it("rotation returns a fresh token and invalidates the previous one", async () => {
    const login = createLogin();
    const profile = createProfile("hc-rotate", login.id);
    actAs(login, profile);

    const first = await connectHealthConnect("never");
    const second = await connectHealthConnect("never");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.token).not.toBe(first.token);
    expect(resolveHealthConnectProfile(first.token)).toBeNull();
    expect(resolveHealthConnectProfile(second.token)).toBe(profile.id);
  });

  it("disconnect clears the connection so the token stops resolving", async () => {
    const login = createLogin();
    const profile = createProfile("hc-disc", login.id);
    actAs(login, profile);
    const res = await connectHealthConnect("never");
    if (!res.ok) throw new Error("expected mint");
    await disconnect();
    expect(resolveHealthConnectProfile(res.token)).toBeNull();
  });

  it("refuses a read-only acting session (requireWriteAccess)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("hc-readonly", login.id);
    actAs(login, profile, "read");
    await expect(connectHealthConnect("never")).rejects.toThrow();
  });
});
