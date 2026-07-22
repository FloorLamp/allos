// DB INTEGRATION TIER — the episode↔visit MANY-model lifecycle (#1198) and the
// recently-resolved reopen affordance (#1140 Part A). Covers: the 094 migration data-move
// (existing single FK links become link rows, then the column is dropped); episode delete
// clears its visit links + stopped-med records; episode merge re-parents them onto the
// keeper; and reopenEligibleEpisodeForProfile uses the SAME 7-day window as the detail
// page. Deterministic :memory: DB.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { up as up094 } from "@/lib/migrations/versions/094-episode-encounters";
import {
  linkEpisodeToEncounter,
  encountersForEpisode,
} from "@/lib/queries";
import {
  createEpisodeRow,
  deleteEpisodeRow,
  mergeEpisodeRows,
  reopenEligibleEpisodeForProfile,
} from "@/lib/illness-episode-store";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newEncounter(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO encounters (profile_id, date, type) VALUES (?, ?, 'Visit')"
      )
      .run(profileId, date).lastInsertRowid
  );
}
function stoppedMedCount(profileId: number, episodeId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM episode_stopped_meds WHERE profile_id = ? AND episode_id = ?"
      )
      .get(profileId, episodeId) as { n: number }
  ).n;
}
function insertStoppedMed(profileId: number, episodeId: number): void {
  const itemId = Number(
    db
      .prepare(
        "INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Amoxicillin', 'medication')"
      )
      .run(profileId).lastInsertRowid
  );
  const courseId = Number(
    db
      .prepare(
        "INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason) VALUES (?, '2026-01-01', '2026-01-05', 'illness_resolved')"
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO episode_stopped_meds (profile_id, episode_id, item_id, course_id) VALUES (?, ?, ?, ?)"
  ).run(profileId, episodeId, itemId, courseId);
}

describe("migration 094 data move (single FK → link rows)", () => {
  it("moves each non-null illness_episodes.encounter_id into a link row, drops the column, and replays clean", () => {
    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = OFF");
    mem.exec("CREATE TABLE profiles(id INTEGER PRIMARY KEY);");
    mem.exec(
      "CREATE TABLE encounters(id INTEGER PRIMARY KEY, profile_id INT, date TEXT);"
    );
    mem.exec(`CREATE TABLE illness_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
      situation TEXT NOT NULL, started_at TEXT, ended_at TEXT, note TEXT, outcome TEXT,
      encounter_id INTEGER REFERENCES encounters(id));`);
    mem.exec(
      "CREATE INDEX idx_illness_episodes_encounter ON illness_episodes(profile_id, encounter_id);"
    );
    mem.exec("INSERT INTO profiles(id) VALUES (1);");
    mem.exec("INSERT INTO encounters(id,profile_id,date) VALUES (7,1,'2024-01-01');");
    mem.exec(
      "INSERT INTO illness_episodes(profile_id,situation,started_at,encounter_id) VALUES (1,'Flu','2024-01-01',7);"
    );
    mem.exec(
      "INSERT INTO illness_episodes(profile_id,situation,started_at,encounter_id) VALUES (1,'Cold','2024-02-01',NULL);"
    );

    up094(mem);
    up094(mem); // replay is a no-op

    const cols = (
      mem.prepare("PRAGMA table_info(illness_episodes)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("encounter_id");
    expect(
      mem
        .prepare(
          "SELECT profile_id, episode_id, encounter_id FROM episode_encounters"
        )
        .all()
    ).toEqual([{ profile_id: 1, episode_id: 1, encounter_id: 7 }]);
    mem.close();
  });
});

describe("episode delete + merge carry the visit-link side-state (#1198/#203)", () => {
  it("deleting an episode clears its visit links + stopped-med records", () => {
    const p = newProfile("Del");
    const epId = createEpisodeRow(p, "Flu", "2026-03-01", "2026-03-08");
    const e = newEncounter(p, "2026-03-04");
    linkEpisodeToEncounter(p, epId, e);
    insertStoppedMed(p, epId);
    expect(encountersForEpisode(p, epId)).toHaveLength(1);
    expect(stoppedMedCount(p, epId)).toBe(1);

    expect(deleteEpisodeRow(p, epId)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episode_encounters WHERE episode_id = ?"
        )
        .get(epId)
    ).toEqual({ n: 0 });
    expect(stoppedMedCount(p, epId)).toBe(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM visit_link_decisions WHERE profile_id = ? AND domain = 'episode'"
        )
        .get(p)
    ).toEqual({ n: 0 });
  });

  it("merging episodes re-parents the loser's links onto the keeper (de-duped)", () => {
    const p = newProfile("Merge");
    const keep = createEpisodeRow(p, "Flu", "2026-03-01", "2026-03-05");
    const drop = createEpisodeRow(p, "Flu", "2026-03-05", "2026-03-09");
    const shared = newEncounter(p, "2026-03-04");
    const only = newEncounter(p, "2026-03-07");
    linkEpisodeToEncounter(p, keep, shared);
    linkEpisodeToEncounter(p, drop, shared); // duplicate across the two
    linkEpisodeToEncounter(p, drop, only);
    insertStoppedMed(p, drop);

    expect(mergeEpisodeRows(p, keep, drop)).toBe(keep);
    // Keeper now holds the union (shared collapses to one).
    expect(encountersForEpisode(p, keep).map((e) => e.id).sort()).toEqual(
      [shared, only].sort()
    );
    // Loser has no residual links, and its stopped-med record moved to the keeper.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episode_encounters WHERE episode_id = ?"
        )
        .get(drop)
    ).toEqual({ n: 0 });
    expect(stoppedMedCount(p, keep)).toBe(1);
    expect(stoppedMedCount(p, drop)).toBe(0);
  });
});

describe("recently-resolved reopen eligibility (#1140 Part A)", () => {
  it("shows a 6-days-resolved episode and hides an 8-days-resolved one (same 7-day window)", () => {
    const p = newProfile("Reopen");
    // ended_at is EXCLUSIVE → last active day = ended_at - 1. Resolved 6 days ago:
    // last active day = today-6 ⇒ ended_at = today-5.
    const sixAgoEnd = shiftDateStr(today(p), -5);
    createEpisodeRow(p, "Cold", shiftDateStr(today(p), -10), sixAgoEnd);
    const eligible = reopenEligibleEpisodeForProfile(p);
    expect(eligible?.situation).toBe("Cold");

    const q = newProfile("Expired");
    // Resolved 8 days ago: last active = today-8 ⇒ ended_at = today-7 (> 7-day window).
    createEpisodeRow(q, "Cold", shiftDateStr(today(q), -12), shiftDateStr(today(q), -7));
    expect(reopenEligibleEpisodeForProfile(q)).toBeNull();
  });

  it("hides the affordance when the same situation is open again (a hero cockpit)", () => {
    const p = newProfile("Relapse");
    createEpisodeRow(p, "Flu", shiftDateStr(today(p), -8), shiftDateStr(today(p), -2));
    // A currently-open Flu episode → not a reopen prompt.
    createEpisodeRow(p, "Flu", shiftDateStr(today(p), -1), null);
    expect(reopenEligibleEpisodeForProfile(p)).toBeNull();
  });
});
