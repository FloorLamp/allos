import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 128 (issue #1739): the MyChart acquirer's allos-side identity surface —
// a portal registry and the `(portal, patient-label) → profile` mapping the remote
// upload API (#1735/#1740) resolves against.
//
// THE PROBLEM. An external, attended tool signs into Epic MyChart portals on the USER'S
// machine (2FA needs a person; sessions idle out in minutes), downloads the portal's own
// export, and pushes it through the token-authenticated upload endpoint. One portal login
// commonly covers several patients through proxy access. If the TOOL decided which allos
// profile each patient maps to, that mapping would live in local config on every machine
// running it — and a stale local mapping filing one person's records under another is
// exactly the harm this feature must not cause. So the tool reports an external identity
// verbatim and ALLOS resolves it, against these tables, intersected with the pushing
// token's write set.
//
// ── SECURITY PROPERTY: A PORTAL HAS NO ADDRESS HERE, BY SCHEMA ───────────────
//
// `portals` stores a slug and a display name and DELIBERATELY HAS NO URL COLUMN. This is
// not an omission to be tidied up later — it is the property the whole design rests on,
// so read this before adding any column:
//
//   A portal is two things with different owners. Its IDENTITY is allos-owned: the
//   mapping needs a foreign key allos controls, and sync events and provenance need one
//   stable portal key across every device running the tool. Its ADDRESS is TOOL-owned —
//   bound in the tool's local config, trust-on-first-use, pinned on the user's machine.
//
//   Because allos never stores, transmits, or accepts an address, the standing rule —
//   *any future trigger payload may carry names and ids resolved against local config,
//   never a URL* — holds BY CONSTRUCTION rather than by remembering to enforce it. The
//   authoritative record contains nothing resolvable, so a hostile page or a compromised
//   job queue cannot aim an attended browser tool at an attacker-controlled login form
//   that looks exactly like the real portal.
//
// DO NOT ADD a `url`, `base_url`, `host`, or `login_url` column here as a convenience.
// Doing so would silently convert this record into something an attacker can aim. The
// write path additionally refuses URL-shaped text in the display NAME
// (`rejectsAddress()` in lib/acquirer-identity.ts), because a free-text field is the one
// place an address could otherwise slip in.
//
// ── TABLES ───────────────────────────────────────────────────────────────────
//
//   portals — GLOBAL, like `providers` and `logins`. A household sees one "Ochsner
//     MyChart" regardless of which family members it covers, and the slug is the stable
//     key the tool, the sync events, and document provenance all quote. It carries no
//     profile_id and therefore does NOT join lib/owned-tables.ts. `slug` is UNIQUE and
//     COLLATE NOCASE so one portal cannot be registered twice under different casing and
//     then resolve inconsistently.
//
//   portal_identities — the mapping, and it IS profile-owned: it carries profile_id, so
//     it joins lib/owned-tables.ts and is cleared when a profile is deleted. That is not
//     bookkeeping — a mapping left dangling after a profile is deleted would resolve an
//     incoming upload onto a profile that no longer exists, i.e. the misfiling this
//     feature exists to prevent. UNIQUE(portal_id, patient_label) is what makes the
//     binding a KEY: one patient label on one portal resolves to exactly one profile, and
//     a rebind REPLACES rather than accumulating an ambiguous second answer.
//
//     `patient_label` is stored VERBATIM (only whitespace-normalized by
//     normalizePatientLabel — see that function's note on why nothing is case-folded).
//     The portal's proxy list defines these strings; the tool discovers them; allos only
//     binds them. Case-folding or fuzzy-matching two labels into one is how one patient's
//     records land under another's profile, so the column is compared exactly.
//
//     Both FKs are ON DELETE CASCADE: dropping a portal or a profile takes its bindings
//     with it. deleteProfile also clears the table explicitly (OWNED_TABLES), so the
//     teardown holds even with foreign_keys off — the posture every profile-owned table
//     already uses.
//
// House rules (CLAUDE.md): new tables only, no rebuild, so there is nothing to null
// beforehand. Self-contained — imports nothing from lib/ — so a replay is decided purely
// by the DB catalog and this file's own constants. Determinism (spec): reads only the DB
// catalog.

export function up(db: Database.Database): void {
  // Portal IDENTITY only. See the header: there is no address column here on purpose.
  db.exec(
    `CREATE TABLE IF NOT EXISTS portals (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       slug       TEXT NOT NULL,
       name       TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_portals_slug
       ON portals(slug COLLATE NOCASE)`
  );

  // The binding. Profile-owned (carries profile_id) → lib/owned-tables.ts.
  db.exec(
    `CREATE TABLE IF NOT EXISTS portal_identities (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       portal_id     INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
       patient_label TEXT NOT NULL,
       profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
       created_at    TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
  // One label on one portal resolves to exactly one profile. Case-SENSITIVE by design
  // (see the header): two visibly different labels are two different people.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_identities_key
       ON portal_identities(portal_id, patient_label)`
  );
  // The card lists a profile's bindings, and deleteProfile clears by profile_id.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_portal_identities_profile
       ON portal_identities(profile_id)`
  );
}

export const migration: Migration = {
  id: 128,
  name: "128-portal-identity",
  up,
};
