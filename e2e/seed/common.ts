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

// The scrypt hash of the ONE password every e2e fixture login shares, computed at
// most once per seed process.
//
// scrypt is deliberately expensive — that is the whole point of a KDF, and
// `lib/password.ts` is tuned so a real login costs real work. A fixture whose
// password is a constant committed in this repo buys nothing with that work, and
// the e2e seed creates ~180 of them: profiling the template seed put **17.3 s of
// its ~25 s inside `scryptSync`**, paid again on every shard, every push. Worse,
// `seedMemberLogin` hashed BEFORE its `INSERT OR IGNORE`, so a login that already
// existed paid in full for a row that was then discarded.
//
// Hashing once means every fixture login shares one salt. That is meaningless for
// fixtures (they are not credentials, and the stored form is self-describing, so
// `verifyPassword` reads them exactly as before) — and it is already the
// established pattern: `sleep-page.spec.ts` copies `password_hash` off a template
// login rather than re-hashing, for the same reason.
//
// This deliberately does NOT touch `lib/password.ts`. Production and bootstrap
// hashing are unchanged by construction; the memo lives in e2e seed code only.
let memberHash: string | undefined;
export function memberPasswordHash(): string {
  return (memberHash ??= hashPasswordSync(E2E_MEMBER_PASSWORD));
}

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
  ).run(username, memberPasswordHash());
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
