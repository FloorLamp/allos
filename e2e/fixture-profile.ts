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
