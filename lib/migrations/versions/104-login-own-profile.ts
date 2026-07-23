import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 104 (issue #1013): the optional OWN-PROFILE link on a login.
//
// Logins and profiles are deliberately decoupled — a login has GRANTED profiles
// (login_profiles) but no concept of "this one is ME". Without that, no surface can
// tell your own record apart from someone else's, so the not-self write affordances
// (#1013) and the profile banner's not-self states (#1096) have nothing to key on.
// This adds that missing definition: `logins.own_profile_id`, an OPTIONAL pointer
// from a login to ONE of its accessible profiles ("mine").
//
// AN ASSOCIATION, NOT AN ACCESS GRANT. Access is governed exactly as before by
// login_profiles + admin-bypass; own_profile_id only labels which accessible profile
// is the login's self. It is re-validated on every read (resolveScope ∩ accessible),
// so a revoked grant silently drops the link back to null — the same "re-derive
// against current grants" stance the active profile + view-set already take. Setting
// it is constrained to the login's accessible profiles at the write boundary.
//
// GLOBAL, login-scoped auth infrastructure (no `profile_id`), so — like logins.email
// (064) — it is NOT profile-owned and does NOT go in lib/owned-tables.ts.
//
// A real FK (REFERENCES profiles(id)) per the FK-link-integrity convention (#95): a
// nullable link column carries a real reference on every DB population. ADD COLUMN
// with a REFERENCES clause is legal because the default is NULL (SQLite forbids a
// non-NULL default there). SQLite can't attach an ON DELETE action to a column added
// this way, so profile deletion nulls the link EXPLICITLY (deleteProfile, the
// row-side-state convention) rather than by cascade. CREATE-style additive ALTER
// keeps the non-version-gated migrate() replay a no-op (the column already exists on
// a current DB).

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(logins)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "own_profile_id")) {
    db.exec(
      "ALTER TABLE logins ADD COLUMN own_profile_id INTEGER REFERENCES profiles(id)"
    );
  }
}

export const migration: Migration = {
  id: 104,
  name: "104-login-own-profile",
  up,
};
