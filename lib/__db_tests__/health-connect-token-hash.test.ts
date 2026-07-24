// DB INTEGRATION TIER — Health Connect ingest token is hashed at rest (#1209).
//
// Every other minted secret in the app stores only a SHA-256 and matches by hash;
// the Health Connect push token was the one raw-stored exception. This tier proves
// the hash-at-rest posture: a generated token still resolves (matched by hash), the
// stored config carries NO plaintext, rotation invalidates the old value, and an
// expired token still yields the same null (no oracle) — while the presented value
// the phone sends is unchanged.

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  generateHealthConnectToken,
  getConnection,
  getHealthConnectTokenInfo,
  upsertConnection,
  resolveHealthConnectProfile,
} from "@/lib/integrations/connections";

let profileId: number;

function storedConfig(pid: number): Record<string, unknown> {
  const conn = getConnection(pid, "health-connect");
  return conn?.config ? JSON.parse(conn.config) : {};
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-HASH')").run()
      .lastInsertRowid
  );
});

describe("Health Connect token hash-at-rest (#1209)", () => {
  it("a generated token resolves by hash to its profile", () => {
    const token = generateHealthConnectToken(profileId, "never");
    expect(resolveHealthConnectProfile(token)).toBe(profileId);
    // A bogus bearer never resolves.
    expect(resolveHealthConnectProfile("not-the-token")).toBeNull();
  });

  it("stores only the SHA-256, never the plaintext token", () => {
    const token = generateHealthConnectToken(profileId, "never");
    const cfg = storedConfig(profileId);
    // No plaintext anywhere in the stored config.
    expect(cfg.token).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain(token);
    // The stored hash is exactly sha256(token) hex.
    expect(cfg.tokenHash).toBe(
      crypto.createHash("sha256").update(token).digest("hex")
    );
    // The lifecycle info surface never exposes the plaintext either.
    const info = getHealthConnectTokenInfo(profileId);
    expect(info.hasToken).toBe(true);
    expect(info.source).toBe("db");
    expect(info.envToken).toBeNull();
    expect(JSON.stringify(info)).not.toContain(token);
  });

  it("rotation invalidates the old value and validates the new one", () => {
    const first = generateHealthConnectToken(profileId, "never");
    const second = generateHealthConnectToken(profileId, "never");
    expect(second).not.toBe(first);
    // The old token no longer resolves; the fresh one does.
    expect(resolveHealthConnectProfile(first)).toBeNull();
    expect(resolveHealthConnectProfile(second)).toBe(profileId);
  });

  it("an expired token yields the same null as a bogus one (no oracle)", () => {
    const token = generateHealthConnectToken(profileId, "90d");
    // Force the stored expiry into the past.
    const cfg = storedConfig(profileId);
    cfg.tokenExpiresAt = new Date(Date.now() - 3_600_000).toISOString();
    upsertConnection(profileId, "health-connect", { config: cfg });
    // Real-but-expired presents identically to a bogus token: both null.
    expect(resolveHealthConnectProfile(token)).toBeNull();
    expect(resolveHealthConnectProfile("bogus")).toBeNull();
  });
});
