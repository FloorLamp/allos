import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issues #5121 (owner ruling, 2026-09-16) and #5911 — A SHARED BOTTLE REMEMBERS ITS OWN
// FILL. The owner's words: "both private and shared bottles should have a usual refill."
//
// WHAT WAS MISSING. `intake_items.last_fill_size` (migration 047) records the size a
// person last refilled an item by, and nothing about WHICH container that was a fill of.
// `shared_supplies` (migration 112) has `quantity_on_hand` but no remembered fill at all,
// so the pooled arm of `refillSupply` reached for a MEMBER's size to answer a one-tap on
// the bottle. `linkItemToPool` nulls the item's private count and keeps its
// `last_fill_size`, so a 30 that was a fill of somebody's own bottle could be one-tapped
// into a 500-count household jar nobody ever filled with 30 of anything (#5911).
//
// WHY A COLUMN AND NOT A PREDICATE. Two review rounds on #5908 tried to keep reading the
// member and filter which member was safe to read — first on `active`, then on `active`
// plus a consumption rate — and both were falsified by a single fully-active sole member
// that had simply been refilled before it was linked. The member is not where the
// information is missing; PROVENANCE is. A remembered fill has to be attributable to the
// container it will be added to, so the container carries it.
//
// NOTHING IS BACKFILLED, DELIBERATELY. Every bottle starts at NULL, which is exactly the
// ask-once state #5908 shipped as the interim: a shared bottle's FIRST refill asks for
// the size, and that number — typed for this bottle — is what the column then holds for
// every later one-tap. Seeding the column from any member's `last_fill_size` would be the
// precise write this change exists to remove, and the supply rules forbid copying another
// person's stock besides. A household's count moves only by a number somebody stated
// about that household's bottle.
//
// `shared_supplies` stays household-shared and NOT profile-owned (the migration 112
// header explains why): this column carries no new subject and no new custody decision,
// only the same fact `quantity_on_hand` already is, one step earlier.
//
// Replay safety: the ALTER sits behind a column probe, so the non-version-gated
// `migrate()` replay used by the DB test tier is a pure no-op.

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((row) => row.name === column);
}

export function up(db: Database.Database): void {
  // REAL, matching `intake_items.last_fill_size` (migration 047) and the pool's own
  // `quantity_on_hand`: a fill can be half a bottle of liquid as easily as 90 tablets.
  if (!hasColumn(db, "shared_supplies", "last_fill_size")) {
    db.exec(`ALTER TABLE shared_supplies ADD COLUMN last_fill_size REAL;`);
  }
}

export const migration: Migration = {
  name: "20260916-shared-supply-last-fill",
  up,
};
