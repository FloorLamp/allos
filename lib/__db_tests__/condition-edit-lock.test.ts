// DB INTEGRATION TIER — the episode-promoted condition edit lock (#2137,
// migration 161).
//
// syncPromotedCondition runs on every promote, end, reopen, and boundary edit, and
// used to rewrite name/status/onset_date/resolved_date unconditionally — so a
// hand-corrected episode-sourced condition silently reverted on the next episode
// transition. It was the ONE derived row without the isEditLocked treatment. These
// tests pin the treatment: the manual edit path stamps `edited`, the sync consults
// it through the SAME predicate as every imported store, and a locked row is a FULL
// hold-out — it receives nothing, not even the episode's resolved_date on close.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  promoteEpisodeToConditionCore,
  syncPromotedCondition,
  editEpisodeCore,
} from "@/lib/illness-episode-write";
import { getEpisodeRow, mergeEpisodeRows } from "@/lib/illness-episode-store";
import { episodeConditionExternalId } from "@/lib/illness-episode-format";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newEpisode(
  profileId: number,
  startedAt: string,
  endedAt: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(profileId, startedAt, endedAt).lastInsertRowid
  );
}

function conditionRow(profileId: number, episodeId: number) {
  return db
    .prepare(
      `SELECT name, status, onset_date, resolved_date, edited
         FROM conditions WHERE profile_id = ? AND external_id = ?`
    )
    .get(profileId, episodeConditionExternalId(episodeId)) as
    | {
        name: string;
        status: string;
        onset_date: string | null;
        resolved_date: string | null;
        edited: number;
      }
    | undefined;
}

// The manual correction, as the conditions edit form writes it (updateCondition
// stamps `edited = 1` alongside the values — pinned in the action tier).
function handCorrect(
  profileId: number,
  episodeId: number,
  values: { name: string; status: string }
): void {
  db.prepare(
    `UPDATE conditions SET name = ?, status = ?, edited = 1
      WHERE profile_id = ? AND external_id = ?`
  ).run(
    values.name,
    values.status,
    profileId,
    episodeConditionExternalId(episodeId)
  );
}

describe("conditions.edited — migration 161 schema", () => {
  it("exists and defaults to 0 (every pre-existing row un-locked)", () => {
    const cols = db.prepare(`PRAGMA table_info(conditions)`).all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const edited = cols.find((c) => c.name === "edited");
    expect(edited).toBeDefined();
    expect(edited!.dflt_value).toBe("0");
  });
});

describe("syncPromotedCondition consults the edit lock (#2137)", () => {
  it("an unedited promoted condition still follows every episode transition", () => {
    const p = newProfile("lock-unedited");
    const episodeId = newEpisode(p, "2026-06-01", "2026-06-06");
    expect(promoteEpisodeToConditionCore(p, episodeId).kind).toBe("promoted");

    // Boundary edit → the derivation moves and the row follows.
    expect(
      editEpisodeCore(p, episodeId, "2026-06-02", "2026-06-08", null, null)
    ).toBe(true);
    const row = conditionRow(p, episodeId);
    expect(row).toMatchObject({
      name: "Illness",
      status: "resolved",
      onset_date: "2026-06-02",
      resolved_date: "2026-06-07", // end-1, the last active day
      edited: 0,
    });
    // The sync's own accounting says it wrote.
    expect(syncPromotedCondition(p, getEpisodeRow(p, episodeId)!)).toBe(
      "synced"
    );
  });

  it("a hand-corrected promoted condition survives the next transition — full hold-out", () => {
    const p = newProfile("lock-edited");
    const episodeId = newEpisode(p, "2026-06-01", "2026-06-06");
    expect(promoteEpisodeToConditionCore(p, episodeId).kind).toBe("promoted");

    // The user corrects the name and marks it inactive by hand.
    handCorrect(p, episodeId, {
      name: "Chronic sinusitis",
      status: "inactive",
    });

    // The episode transitions (boundary edit): the sync detects the lock, skips,
    // and its accounting shows the hold-out.
    expect(
      editEpisodeCore(p, episodeId, "2026-05-20", "2026-06-10", null, null)
    ).toBe(true);
    expect(conditionRow(p, episodeId)).toMatchObject({
      name: "Chronic sinusitis",
      status: "inactive",
      onset_date: "2026-06-01", // untouched — not even the boundary moved it
      resolved_date: "2026-06-05",
      edited: 1,
    });
    expect(syncPromotedCondition(p, getEpisodeRow(p, episodeId)!)).toBe(
      "locked"
    );
  });

  it("a locked row does not receive the episode's resolved_date on close (the ruling)", () => {
    const p = newProfile("lock-close");
    const episodeId = newEpisode(p, "2026-06-01", null); // ongoing
    expect(promoteEpisodeToConditionCore(p, episodeId).kind).toBe("promoted");
    expect(conditionRow(p, episodeId)).toMatchObject({
      status: "active",
      resolved_date: null,
    });

    // Hand-correct while the episode is still open.
    handCorrect(p, episodeId, { name: "Illness", status: "inactive" });

    // Close the episode via the boundary edit. An unlocked row would flip to
    // resolved with end-1; the locked row receives NOTHING — full hold-out.
    expect(
      editEpisodeCore(p, episodeId, "2026-06-01", "2026-06-09", null, null)
    ).toBe(true);
    expect(conditionRow(p, episodeId)).toMatchObject({
      status: "inactive",
      resolved_date: null,
      edited: 1,
    });
  });

  it("reports 'none' for a never-promoted episode", () => {
    const p = newProfile("lock-none");
    const episodeId = newEpisode(p, "2026-06-01", "2026-06-06");
    expect(syncPromotedCondition(p, getEpisodeRow(p, episodeId)!)).toBe("none");
  });

  it("the merge value-sync honours the lock; the re-anchor still repoints an edited row", () => {
    const p = newProfile("lock-merge");
    // Keeper promoted + hand-edited; loser promoted (unedited).
    const keepId = newEpisode(p, "2026-06-01", "2026-06-04");
    const dropId = newEpisode(p, "2026-06-06", "2026-06-09");
    expect(promoteEpisodeToConditionCore(p, keepId).kind).toBe("promoted");
    handCorrect(p, keepId, { name: "Sinus infection", status: "inactive" });

    // Merge widens the keeper to the union range. The keeper's LOCKED condition
    // keeps its hand values (the value-sync is `AND edited = 0`).
    expect(mergeEpisodeRows(p, keepId, dropId)).toBe(keepId);
    expect(conditionRow(p, keepId)).toMatchObject({
      name: "Sinus infection",
      status: "inactive",
      onset_date: "2026-06-01",
      resolved_date: "2026-06-03",
      edited: 1,
    });

    // Identity maintenance is NOT gated: a hand-edited LOSER condition re-anchors
    // onto the keeper (keeping its values) when the keeper has none of its own.
    const p2 = newProfile("lock-merge-reanchor");
    const keep2 = newEpisode(p2, "2026-06-01", "2026-06-04");
    const drop2 = newEpisode(p2, "2026-06-06", "2026-06-09");
    expect(promoteEpisodeToConditionCore(p2, drop2).kind).toBe("promoted");
    handCorrect(p2, drop2, { name: "Bronchitis", status: "inactive" });
    expect(mergeEpisodeRows(p2, keep2, drop2)).toBe(keep2);
    expect(conditionRow(p2, keep2)).toMatchObject({
      name: "Bronchitis",
      status: "inactive",
      edited: 1,
    });
  });
});
