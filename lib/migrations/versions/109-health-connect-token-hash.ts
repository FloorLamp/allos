import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 109 (issue #1209): hash the Health Connect ingest token at rest.
//
// Every other minted secret in the app stores only a SHA-256 and matches by hash
// (session tokens, share-link tokens, calendar-feed tokens, 2FA recovery codes).
// The Health Connect push token was the one raw-stored exception — it lived as the
// plaintext `token` key inside the integration_connections.config JSON so the setup
// page could re-show it. A DB read (backup, snapshot) therefore exposed a LIVE
// credential rather than a useless hash. The app now stores `tokenHash` and matches
// a presented bearer by hashing it, with reveal-once at generate/rotate (the setup
// page's re-copy affordance became a Rotate button).
//
// This one-shot rewrites every EXISTING raw-stored token in place: for each
// health-connect connection whose config JSON carries a plaintext `token` string,
// replace that key with `tokenHash` = sha256(token). The phone keeps working with no
// re-pairing because the PRESENTED value is unchanged — resolveHealthConnectProfile
// now hashes the presented bearer and matches the stored hash. The lifecycle stamps
// (tokenCreatedAt/tokenExpiresAt/tokenLastUsedAt, #24) are preserved untouched.
//
// Self-contained (manifest freeze — never imports lib/): plain better-sqlite3 + the
// same sha256(hex) that lib/share-token.ts computes. Replay-safe (the non-version-
// gated migrate() wrapper replays up() unconditionally): after the first run no
// config carries a plaintext `token`, so every row is skipped. The HEALTH_CONNECT_
// TOKEN env fallback is untouched — it's operator config, not a minted credential,
// and is out of scope (#1209).
export function up(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT profile_id, config FROM integration_connections WHERE provider = 'health-connect' AND config IS NOT NULL"
    )
    .all() as { profile_id: number; config: string }[];
  const update = db.prepare(
    "UPDATE integration_connections SET config = ?, updated_at = datetime('now') WHERE provider = 'health-connect' AND profile_id = ?"
  );
  for (const r of rows) {
    let cfg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(r.config);
      if (!parsed || typeof parsed !== "object") continue;
      cfg = parsed as Record<string, unknown>;
    } catch {
      continue; // unparseable config: nothing to migrate
    }
    const token = cfg.token;
    if (typeof token !== "string" || !token) continue; // already hashed / no token
    delete cfg.token;
    cfg.tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    update.run(JSON.stringify(cfg), r.profile_id);
  }
}

export const migration: Migration = {
  id: 109,
  name: "109-health-connect-token-hash",
  up,
};
