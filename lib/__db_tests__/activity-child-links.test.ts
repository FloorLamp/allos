// DB INTEGRATION TIER — every way a row can point at an activity is a merge decision
// somebody wrote down (#5481).
//
// The photo loss this pins down was not really a missing UPDATE; it was a
// hand-maintained list. `writeActivityFold` enumerates an activity's children by hand,
// `activity_videos` was in it because somebody remembered, `training_photos` was not
// because nobody did, and the FK cascaded the moment a merge deleted the drop. The next
// activity-owned table would have gone exactly the same way, silently.
//
// WHY THIS TEST RATHER THAN A DERIVED LIST. `lib/owned-tables.ts` cannot drive the
// moves: it enumerates PROFILE ownership, a different axis, and it deliberately excludes
// child tables — so it names neither `exercise_sets` nor `activity_routes`, the two
// oldest re-parentings in the core. And no list can drive the STATEMENTS either, because
// the disposition differs per table: a blind move for independent rows, a unique keeper
// slot for a route, keeper-wins-per-source for a ride's recordings (moving those blindly
// is what double-counted a ride in #3193). A generated move would have to pick one rule
// for all of them and would be wrong for most.
//
// So the schema declares the SET and `ACTIVITY_CHILD_LINKS` declares the DECISION, and
// this test holds them to each other: it reflects every FK whose parent is `activities`
// out of the LIVE schema (PRAGMA foreign_key_list, the same signal profile-delete.ts
// already walks) and fails unless the two agree exactly. A new activity-owned table now
// fails here until somebody states which line it belongs on — loudly, instead of at the
// next merge.
//
// It also gives the "move" line TEETH: for each table declared a blind move, a row is
// planted on the drop and the real fold must land it on the keeper.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { writeActivityFold, ACTIVITY_CHILD_LINKS } from "@/lib/merge-activity";

const key = (table: string, column: string) => `${table}.${column}`;

// Every (table, column) that REFERENCES activities, straight off the live schema.
function reflectActivityLinks(): Set<string> {
  const out = new Set<string>();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const fks = db.pragma(`foreign_key_list(${name})`) as {
      table: string;
      from: string;
    }[];
    for (const fk of fks)
      if (fk.table === "activities") out.add(key(name, fk.from));
  }
  return out;
}

let profileId: number;
beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CHILD LINKS')").run()
      .lastInsertRowid
  );
});

function insertActivity(title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, '2026-09-07', 'strength', ?, 30)`
      )
      .run(profileId, title).lastInsertRowid
  );
}

// One row on `activityId` for each table declared a blind move, keyed by the same
// `table.column` the declaration uses. Hand-written rather than generated: each table's
// NOT NULL columns are its own, and a generated INSERT would prove less than it costs.
const plantMovableRow: Record<
  string,
  (activityId: number, profile: number) => void
> = {
  "exercise_sets.activity_id": (activityId) => {
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
         VALUES (?, 'Bench', 1, 40, 5)`
    ).run(activityId);
  },
  "activity_videos.activity_id": (activityId, profile) => {
    db.prepare(
      `INSERT INTO activity_videos
           (profile_id, activity_id, stored_path, content_hash)
         VALUES (?, ?, 'data/uploads/activity-videos/x/clip.mp4', 'clip-5481')`
    ).run(profile, activityId);
  },
  "training_photos.activity_id": (activityId, profile) => {
    db.prepare(
      `INSERT INTO training_photos
           (profile_id, activity_id, stored_path, content_hash)
         VALUES (?, ?, 'data/uploads/training-photos/x/shot.jpg', 'shot-5481')`
    ).run(profile, activityId);
  },
};

describe("activity-child links: the schema's set and the merge's decisions agree", () => {
  it("reflects a non-trivial set of activity links from the live schema", () => {
    // Guard against a broken reflection silently passing the assertion below.
    expect(reflectActivityLinks().size).toBeGreaterThan(5);
  });

  it("declares a disposition for every link, and declares no link the schema lacks", () => {
    const reflected = reflectActivityLinks();
    const declared = new Set<string>(ACTIVITY_CHILD_LINKS.map((l) => l.link));

    // A NEW table pointing at activities with no stated disposition — the #5481 shape.
    expect([...reflected].filter((k) => !declared.has(k)).sort()).toEqual([]);
    // ...and no stale declaration for a link the schema no longer has.
    expect([...declared].filter((k) => !reflected.has(k)).sort()).toEqual([]);
    // Every entry carries a reason a human wrote, not an empty string.
    expect(
      ACTIVITY_CHILD_LINKS.filter((l) => l.why.trim().length < 20)
    ).toEqual([]);
  });

  it("actually moves every link it declares a blind move", () => {
    const moves = ACTIVITY_CHILD_LINKS.filter(
      (l) => l.disposition === "move"
    ).map((l) => l.link);
    // The move list is the one that lost a table; pin what is on it today so a silent
    // demotion of `training_photos` to some other line is a failure too.
    expect([...moves].sort()).toEqual([
      "activity_videos.activity_id",
      "exercise_sets.activity_id",
      "training_photos.activity_id",
    ]);

    const keepId = insertActivity("keeper");
    const dropId = insertActivity("drop");
    for (const link of moves) plantMovableRow[link](dropId, profileId);

    const row = (id: number) =>
      db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    writeActivityFold(profileId, keepId, row(keepId), [row(dropId)]);

    const stillOnDrop = moves.filter((link) => {
      const [table, column] = link.split(".");
      return (
        (
          db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`)
            .get(dropId) as { c: number }
        ).c > 0
      );
    });
    expect(stillOnDrop).toEqual([]);

    const onKeeper = moves.filter((link) => {
      const [table, column] = link.split(".");
      return (
        (
          db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`)
            .get(keepId) as { c: number }
        ).c === 1
      );
    });
    expect(onKeeper.sort()).toEqual([...moves].sort());
  });
});
