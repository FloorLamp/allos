// Shared e2e seed helpers + constants used by MORE THAN ONE domain module under
// e2e/seed/. Keep this small: a helper only one domain uses belongs in that domain's
// module. No fixture DATA lives here — only the constructors the domains call.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import { createFixtureProfile } from "../fixture-profile";
import { hashPasswordSync } from "../../lib/password";
import { E2E_MEMBER_PASSWORD } from "../fixture-logins";

// The e2e fixture profile every "profile 1" fixture writes to (the bootstrap admin's).
export const PROFILE_ID = 1;

export const ins = db.prepare(
  `INSERT INTO integration_sync_events
     (profile_id, provider, at, ok, window_start, window_end,
      received, written, inserted, updated, unchanged, skipped, raw_ref, error)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Create a member login (username + scrypt hash) granted exactly ONE profile at the
// given access level. INSERT OR IGNORE keeps it idempotent across a reused dev
// server; the grant is re-asserted either way. Returns the login id.
export function seedMemberLogin(
  username: string,
  profileId: number,
  access: "read" | "write" = "write"
): number {
  db.prepare(
    "INSERT OR IGNORE INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
  ).run(username, hashPasswordSync(E2E_MEMBER_PASSWORD));
  const loginId = (
    db.prepare("SELECT id FROM logins WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
  return loginId;
}

// Look up (or create) a fixture profile by name — idempotent for a reused server.
// Creation goes through createFixtureProfile so the profile starts with the standard
// metric saves a production-created profile gets (#1487) — see e2e/fixture-profile.ts.
export function fixtureProfileId(name: string): number {
  const existing = db
    .prepare("SELECT id FROM profiles WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  return createFixtureProfile(db, name);
}

// Grant an EXISTING login access to an additional profile (seedMemberLogin creates a
// login with exactly one grant; this adds the rest). Idempotent.
export function grantProfile(
  loginId: number,
  profileId: number,
  access: "read" | "write" = "write"
): void {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
}

// "Riley (child)" is seeded by scripts/seed.ts — undefined only if that seed changes.
// Shared because two domains (coverage-gaps, illness) grant fixture logins against it.
export function rileyProfileId(): number | undefined {
  return (
    db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get("Riley (child)") as { id: number } | undefined
  )?.id;
}
