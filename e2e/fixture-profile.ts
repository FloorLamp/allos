import type Database from "better-sqlite3";
import { seedStandardMetricSaves } from "../lib/standard-metric-seeds";

// THE e2e fixture-profile constructor (#1487, rendering half).
//
// The suite's fixture profiles are created with raw SQL — `INSERT INTO profiles` on
// a directly-opened handle — because the seeder is a tsx script and the spec-level
// creators run outside a request, so neither can reach the `createProfile` Server
// Action (which needs an admin session). That was harmless while Trends Overview
// rendered the four standard metric tiles unconditionally.
//
// It stopped being harmless when Overview became MEMBERSHIP-driven: a profile with
// no `saved_items` rows now renders an EMPTY grid. Every raw-SQL fixture profile
// (~107 of them) would have shown the empty state, so any spec that so much as
// glances at Trends on a fixture profile would be asserting against a state no real
// profile can ever be in — production creates a profile through `createProfile` or
// `bootstrapAuth`, and BOTH seed the standard metric saves.
//
// So fixture creation routes through the SAME seeding core as production
// (`lib/standard-metric-seeds.ts`) rather than being special-cased per spec: the
// fixture profiles are then faithful to a real new profile, and a future change to
// what a new profile starts with lands on the fixtures automatically. This is the
// e2e analog of scripts/seed.ts seeding "Riley (child)" the same way.
//
// PAIRED WITH destroyFixtureProfile BELOW. A spec that deletes its own fixture
// profile must go through the destructor — creation now writes side-state (the seed
// rows), and `DELETE FROM profiles` alone hits their FK. Constructor and destructor
// live in the SAME module on purpose, so the next thing profile creation gains is
// removed in the same edit (the #1487 "row operations carry their side-state" rule,
// applied to fixtures).
//
// Kept in a PLAIN module (no @playwright/test import) for the same reason
// e2e/fixture-logins.ts is: the tsx seeder and the specs both import it.
export function createFixtureProfile(
  db: Database.Database,
  name: string
): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  seedStandardMetricSaves(db, id);
  return id;
}

// Same, for a fixture that pins its profile's ID (the household fixtures reserve
// id 2). Returns the id it was given.
export function createFixtureProfileWithId(
  db: Database.Database,
  id: number,
  name: string
): number {
  db.prepare("INSERT INTO profiles (id, name) VALUES (?, ?)").run(id, name);
  seedStandardMetricSaves(db, id);
  return id;
}

// Delete a fixture profile and everything the CONSTRUCTOR gave it. The mirror of
// createFixtureProfile, and the reason it exists: seeding standard metric saves made
// profile creation carry side-state, and a spec's hand-rolled cleanup that still ran
// a bare `DELETE FROM profiles` failed on `saved_items.profile_id`'s foreign key —
// creation gained a side effect, the destructors did not.
//
// SCOPE: constructor-created rows, the references a fixture profile accumulates just
// by being USED, and the profile row itself. A spec's OWN fixture data (its intake
// items, mood logs, metric samples, profile settings…) stays the spec's business and
// is cleared before this call, exactly as before. When the production seeding core
// grows a second table, it is added HERE — that is the whole point of the pairing.
//
// It mirrors what production's `deleteProfile` (Settings → Family) does, for the same
// reasons:
//   • `sessions.active_profile_id` is NULLed, not ignored. A spec that SWITCHED to its
//     fixture profile leaves the shared session pointing at it, and that pointer is a
//     foreign key — deleting the row under it fails. This half is a PRE-EXISTING flake
//     the seeding change merely made constant: the cleanup only survived when the
//     switch-back happened to land first (`main` fails the same way, less often).
//   • grants go too, since a login may not point at a profile that no longer exists.
// The order matters: every reference is cleared before the row it points at.
export function destroyFixtureProfile(
  db: Database.Database,
  profileId: number
): void {
  db.prepare(
    "UPDATE sessions SET active_profile_id = NULL WHERE active_profile_id = ?"
  ).run(profileId);
  db.prepare("DELETE FROM login_profiles WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM saved_items WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM profiles WHERE id = ?").run(profileId);
}
