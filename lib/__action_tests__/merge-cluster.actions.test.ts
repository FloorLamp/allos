// SERVER-ACTION TIER — the N-way cluster merge + keeper-selectable Training Log merge
// (#1081). Proves:
//   - mergeActivityCluster re-verifies EVERY id against the acting profile (a
//     cross-profile drop is skipped, never folded/deleted), tombstones dropped
//     integration rows, and records a merged decision per constituent pair;
//   - the Training Log mergeActivities, given a NON-card keeper, absorbs the originating
//     card, and the batch undo restores ALL dropped rows + their sets + the keeper's
//     pre-fold fields;
//   - a PARTIAL batch undo (#1884) — one token's restore throws mid-batch, per #202's
//     per-token isolation — un-folds only the drops that actually came back, leaving
//     the failed one's fields and re-parented sets reachable on the keeper, and a
//     retry of that token converges to the fully-undone state.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mergeActivityCluster } from "@/app/(app)/data/review-actions";
import { mergeActivities } from "@/app/(app)/training/activity-actions";
import { undoDeletes } from "@/app/(app)/undo-actions";
import { getPairDecisions } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  pairSignature,
  activityToken,
} from "@/lib/import-review/detect";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-06-15";

function insertActivity(
  profileId: number,
  o: Partial<{
    title: string;
    source: string | null;
    external_id: string | null;
    notes: string | null;
    avg_hr: number | null;
    max_hr: number | null;
    distance_km: number;
    start_time: string;
    end_time: string;
  }> = {}
): number {
  const r = {
    title: "Run",
    source: null as string | null,
    external_id: null as string | null,
    notes: null as string | null,
    avg_hr: null as number | null,
    max_hr: null as number | null,
    distance_km: 5,
    start_time: "08:00",
    end_time: "08:30",
    ...o,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, notes, avg_hr,
            max_hr, duration_min, distance_km, start_time, end_time, edited)
         VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, 30, ?, ?, ?, 0)`
      )
      .run(
        profileId,
        DATE,
        r.title,
        r.source,
        r.external_id,
        r.notes,
        r.avg_hr,
        r.max_hr,
        r.distance_km,
        r.start_time,
        r.end_time
      ).lastInsertRowid
  );
}
function insertSet(activityId: number, exercise: string): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 40, 5)`
  ).run(activityId, exercise);
}
const alive = (id: number) =>
  db.prepare("SELECT 1 FROM activities WHERE id = ?").get(id) !== undefined;
const activityRow = (id: number) =>
  db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
// Rewrite a holding row's captured activity `type`. 'not-a-valid-type' violates the
// activities CHECK, so restoreDeletedRow's re-insert throws inside its transaction —
// the "some other integrity surprise" #202's per-token isolation is written for.
// Setting it back to 'cardio' un-poisons the token so the retry can be driven.
function setCapturedType(undoId: number, type: string): void {
  const row = db
    .prepare("SELECT payload FROM deleted_rows WHERE id = ?")
    .get(undoId) as { payload: string };
  const payload = JSON.parse(row.payload);
  payload.rows.activity[0].type = type;
  db.prepare("UPDATE deleted_rows SET payload = ? WHERE id = ?").run(
    JSON.stringify(payload),
    undoId
  );
}
const setCount = (activityId: number) =>
  (
    db
      .prepare("SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?")
      .get(activityId) as { c: number }
  ).c;

beforeEach(() => {
  revalidate.mockClear();
});

describe("mergeActivityCluster — profile scoping (#1081)", () => {
  it("skips a cross-profile drop and merges only the acting profile's rows", async () => {
    const login = createLogin();
    const mine = createProfile("mine", login.id);
    const other = createProfile("other", login.id);
    actAs(login, mine);

    const keep = insertActivity(mine.id, { title: "keeper", notes: "own" });
    const dropMine = insertActivity(mine.id, {
      title: "mine dupe",
      source: "strava",
      external_id: "strava:1",
      start_time: "08:01",
      end_time: "08:31",
    });
    const dropOther = insertActivity(other.id, { title: "other-profile row" });

    const sig = pairSignature(
      activityToken({ id: keep, external_id: null }),
      activityToken({ id: dropMine, external_id: "strava:1" })
    );
    await mergeActivityCluster(
      fd({
        keep_id: keep,
        drop_ids: JSON.stringify([dropMine, dropOther]),
        pair_signatures: JSON.stringify([sig]),
      })
    );

    // The acting profile's drop is folded away; the cross-profile row is untouched.
    expect(alive(keep)).toBe(true);
    expect(alive(dropMine)).toBe(false);
    expect(alive(dropOther)).toBe(true);
    // The dropped Strava row is tombstoned; a merged decision is recorded.
    expect(
      db
        .prepare(
          "SELECT 1 FROM import_tombstones WHERE profile_id = ? AND natural_key = 'strava:1'"
        )
        .get(mine.id)
    ).toBeTruthy();
    expect([...getPairDecisions(mine.id, ACTIVITY_DOMAIN).values()]).toEqual([
      "merged",
    ]);
  });
});

describe("mergeActivityCluster — per-field member choice (#1431)", () => {
  it("lands the CHOSEN member's value over the keeper's fold default", async () => {
    const login = createLogin();
    const mine = createProfile("picker", login.id);
    actAs(login, mine);

    // Three members disagreeing on distance; the keeper's own 5 would win the fold.
    const keep = insertActivity(mine.id, { title: "keeper", distance_km: 5 });
    const d1 = insertActivity(mine.id, {
      title: "d1",
      source: "strava",
      external_id: "strava:p1",
      distance_km: 8,
      avg_hr: 150,
      start_time: "08:01",
      end_time: "08:31",
    });
    const d2 = insertActivity(mine.id, {
      title: "d2",
      distance_km: 12,
      start_time: "08:02",
      end_time: "08:32",
    });

    const sig = pairSignature(
      activityToken({ id: keep, external_id: null }),
      activityToken({ id: d1, external_id: "strava:p1" })
    );
    await mergeActivityCluster(
      fd({
        keep_id: keep,
        drop_ids: JSON.stringify([d1, d2]),
        pair_signatures: JSON.stringify([sig]),
        overrides: JSON.stringify({ distance_km: d2 }),
      })
    );

    const keeper = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keep) as Record<string, unknown>;
    // The chosen member's distance landed — not the keeper's fold-default 5 —
    // and the un-chosen avg_hr still gap-filled from d1.
    expect(keeper.distance_km).toBe(12);
    expect(keeper.avg_hr).toBe(150);
    expect(alive(d1)).toBe(false);
    expect(alive(d2)).toBe(false);
  });

  it("ignores a choice naming a row outside the merge (forged member id)", async () => {
    const login = createLogin();
    const mine = createProfile("picker-forge", login.id);
    const other = createProfile("picker-foreign", login.id);
    actAs(login, mine);

    const keep = insertActivity(mine.id, { title: "keeper", distance_km: 5 });
    const d1 = insertActivity(mine.id, {
      title: "d1",
      source: "strava",
      external_id: "strava:p2",
      distance_km: 8,
      start_time: "08:01",
      end_time: "08:31",
    });
    // A row OUTSIDE the merge (another profile) the forged choice names.
    const foreign = insertActivity(other.id, {
      title: "foreign",
      distance_km: 99,
    });

    const sig = pairSignature(
      activityToken({ id: keep, external_id: null }),
      activityToken({ id: d1, external_id: "strava:p2" })
    );
    await mergeActivityCluster(
      fd({
        keep_id: keep,
        drop_ids: JSON.stringify([d1]),
        pair_signatures: JSON.stringify([sig]),
        overrides: JSON.stringify({ distance_km: foreign }),
      })
    );

    // The forged id resolves to nothing: the keeper-wins fold stands and the
    // foreign row is untouched — its value never entered the merge.
    expect(
      (
        db
          .prepare("SELECT distance_km d FROM activities WHERE id = ?")
          .get(keep) as { d: number }
      ).d
    ).toBe(5);
    expect(alive(foreign)).toBe(true);
  });
});

describe("mergeActivities — non-card keeper + N-way undo (#1081)", () => {
  it("absorbs the originating card when a sibling is keeper, and undo restores everything", async () => {
    const login = createLogin();
    const profile = createProfile("training log", login.id);
    actAs(login, profile);

    // Originating card + two siblings, same day.
    const card = insertActivity(profile.id, {
      title: "card",
      notes: "card-notes",
    });
    insertSet(card, "card-set");
    const sib1 = insertActivity(profile.id, {
      title: "sib1",
      source: "strava",
      external_id: "strava:k",
      avg_hr: 150,
      start_time: "08:01",
      end_time: "08:31",
    });
    insertSet(sib1, "sib1-set");
    const sib2 = insertActivity(profile.id, {
      title: "sib2",
      start_time: "08:02",
      end_time: "08:32",
    });
    insertSet(sib2, "sib2-set");

    // Keeper = sib1 (a sibling): the originating card is itself a drop.
    const { undoIds } = await mergeActivities(
      fd({ keep_id: sib1, drop_ids: JSON.stringify([card, sib2]) })
    );
    expect(undoIds).toHaveLength(2);

    // The card + sib2 are absorbed; sib1 survives with all three sets + gap-filled notes.
    expect(alive(card)).toBe(false);
    expect(alive(sib2)).toBe(false);
    expect(alive(sib1)).toBe(true);
    expect(setCount(sib1)).toBe(3);
    const keeper = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(sib1) as Record<string, unknown>;
    expect(keeper.notes).toBe("card-notes"); // gap-filled from a drop
    expect(keeper.edited).toBe(1);

    // Undo the whole N-way merge: every dropped row returns (new ids) with its own set,
    // and the keeper's pre-fold fields are restored (notes back to null).
    const { restored } = await undoDeletes(undoIds);
    expect(restored).toBe(2);
    expect(setCount(sib1)).toBe(1); // sib1's own set only
    const keeperAfter = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(sib1) as Record<string, unknown>;
    expect(keeperAfter.notes).toBeNull(); // pre-fold restore
    // The originating card is back (restored under a new id, same title + set).
    const restoredCard = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND title = 'card'"
      )
      .get(profile.id) as { id: number } | undefined;
    expect(restoredCard).toBeTruthy();
    expect(setCount(restoredCard!.id)).toBe(1);
    const restoredSib2 = db
      .prepare(
        "SELECT 1 FROM activities WHERE profile_id = ? AND title = 'sib2'"
      )
      .get(profile.id);
    expect(restoredSib2).toBeTruthy();
  });

  it("a per-field member choice lands on the keeper, and undo restores the pre-merge value (#1431)", async () => {
    const login = createLogin();
    const profile = createProfile("training-log-pick", login.id);
    actAs(login, profile);

    // The keeper carries its own distance (5); the chosen member (sibB) carries 12.
    const card = insertActivity(profile.id, { title: "card", distance_km: 5 });
    const sibA = insertActivity(profile.id, {
      title: "sibA",
      distance_km: 8,
      start_time: "08:01",
      end_time: "08:31",
    });
    const sibB = insertActivity(profile.id, {
      title: "sibB",
      distance_km: 12,
      start_time: "08:02",
      end_time: "08:32",
    });

    const { undoIds } = await mergeActivities(
      fd({
        keep_id: card,
        drop_ids: JSON.stringify([sibA, sibB]),
        overrides: JSON.stringify({ distance_km: sibB }),
      })
    );
    expect(undoIds).toHaveLength(2);

    // The chosen (non-keeper) member's distance landed on the keeper.
    expect(
      (
        db
          .prepare("SELECT distance_km d FROM activities WHERE id = ?")
          .get(card) as { d: number }
      ).d
    ).toBe(12);

    // Undo restores the keeper's PRE-MERGE value — the inverse snapshot was taken
    // before the fold, so it holds regardless of which member's value was chosen.
    const { restored } = await undoDeletes(undoIds);
    expect(restored).toBe(2);
    expect(
      (
        db
          .prepare("SELECT distance_km d FROM activities WHERE id = ?")
          .get(card) as { d: number }
      ).d
    ).toBe(5);
    // Both dropped rows are back with their own distances.
    for (const [title, d] of [
      ["sibA", 8],
      ["sibB", 12],
    ] as const) {
      const row = db
        .prepare(
          "SELECT distance_km d FROM activities WHERE profile_id = ? AND title = ?"
        )
        .get(profile.id, title) as { d: number } | undefined;
      expect(row?.d).toBe(d);
    }
  });
});

describe("mergeActivities — PARTIAL-batch undo (#1884)", () => {
  it("un-folds only the drops that came back; the failed one's data stays reachable and a retry converges", async () => {
    const login = createLogin();
    const profile = createProfile("partial-undo", login.id);
    actAs(login, profile);

    // A 3-way merge where each drop fills a DIFFERENT gap on the keeper, so the
    // keeper's columns say exactly which drops are still folded in.
    const keep = insertActivity(profile.id, { title: "keeper" });
    insertSet(keep, "keeper-set");
    const dropA = insertActivity(profile.id, {
      title: "dropA",
      notes: "from-A",
      start_time: "08:01",
      end_time: "08:31",
    });
    insertSet(dropA, "a-set");
    const dropB = insertActivity(profile.id, {
      title: "dropB",
      avg_hr: 150,
      start_time: "08:02",
      end_time: "08:32",
    });
    insertSet(dropB, "b-set");
    const dropC = insertActivity(profile.id, {
      title: "dropC",
      max_hr: 180,
      start_time: "08:03",
      end_time: "08:33",
    });
    insertSet(dropC, "c-set");

    const { undoIds } = await mergeActivities(
      fd({ keep_id: keep, drop_ids: JSON.stringify([dropA, dropB, dropC]) })
    );
    expect(undoIds).toHaveLength(3);
    const [tokenA, tokenB, tokenC] = undoIds;

    const merged = activityRow(keep);
    expect([merged.notes, merged.avg_hr, merged.max_hr]).toEqual([
      "from-A",
      150,
      180,
    ]);
    expect(setCount(keep)).toBe(4);

    // Poison the MIDDLE token so its restore throws mid-batch while A and C succeed.
    setCapturedType(tokenB, "not-a-valid-type");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { restored } = await undoDeletes([tokenA, tokenB, tokenC]);
    errSpy.mockRestore();
    expect(restored).toBe(2);

    // (i) The keeper lost A's and C's contributions and KEPT B's — it now reads as
    //     exactly the K+B merge it still is, not as the pre-merge row.
    const partial = activityRow(keep);
    expect([partial.notes, partial.avg_hr, partial.max_hr]).toEqual([
      null,
      150,
      null,
    ]);
    expect(partial.edited).toBe(1); // still a merged result

    // (ii) B's re-parented set is still on the keeper — reachable, not orphaned —
    //      while A's and C's rode back to their own rows.
    expect(setCount(keep)).toBe(2);

    // (iii) The successfully restored drops are whole: own row, own values, own set.
    for (const [title, field, value] of [
      ["dropA", "notes", "from-A"],
      ["dropC", "max_hr", 180],
    ] as const) {
      const row = db
        .prepare("SELECT * FROM activities WHERE profile_id = ? AND title = ?")
        .get(profile.id, title) as Record<string, unknown>;
      expect(row[field]).toBe(value);
      expect(setCount(row.id as number)).toBe(1);
    }
    // B is still deleted, and its holding row survived for a retry.
    expect(
      db
        .prepare("SELECT 1 FROM activities WHERE profile_id = ? AND title = ?")
        .get(profile.id, "dropB")
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM deleted_rows WHERE id = ?").get(tokenB)
    ).toBeTruthy();

    // (iv) Retrying the failed token converges to the fully-undone state.
    setCapturedType(tokenB, "cardio");
    expect((await undoDeletes([tokenB])).restored).toBe(1);
    const undone = activityRow(keep);
    expect([undone.notes, undone.avg_hr, undone.max_hr]).toEqual([
      null,
      null,
      null,
    ]);
    expect(undone.edited).toBe(0); // the keeper's own pre-merge lock is back
    expect(setCount(keep)).toBe(1);
    const restoredB = db
      .prepare("SELECT * FROM activities WHERE profile_id = ? AND title = ?")
      .get(profile.id, "dropB") as Record<string, unknown>;
    expect(restoredB.avg_hr).toBe(150);
    expect(setCount(restoredB.id as number)).toBe(1);
  });

  it("keeps a still-folded drop's per-field choice while dropping a restored drop's (#1431)", async () => {
    const login = createLogin();
    const profile = createProfile("partial-undo-pick", login.id);
    actAs(login, profile);

    // The keeper's own distance would win the fold; the picker hands the field to
    // dropB instead. dropA carries a distance too, so the choice is what decides.
    const keep = insertActivity(profile.id, {
      title: "keeper",
      distance_km: 5,
    });
    const dropA = insertActivity(profile.id, {
      title: "dropA",
      distance_km: 8,
      notes: "from-A",
      start_time: "08:01",
      end_time: "08:31",
    });
    const dropB = insertActivity(profile.id, {
      title: "dropB",
      distance_km: 12,
      start_time: "08:02",
      end_time: "08:32",
    });

    const { undoIds } = await mergeActivities(
      fd({
        keep_id: keep,
        drop_ids: JSON.stringify([dropA, dropB]),
        overrides: JSON.stringify({ distance_km: dropB }),
      })
    );
    expect(activityRow(keep).distance_km).toBe(12);

    // Undo only dropA (dropB stays folded in): the choice named dropB, which is
    // still a member, so its distance holds — only A's notes gap-fill is un-folded.
    const [tokenA, tokenB] = undoIds;
    expect((await undoDeletes([tokenA])).restored).toBe(1);
    const partial = activityRow(keep);
    expect(partial.distance_km).toBe(12);
    expect(partial.notes).toBeNull();

    // Undo dropB too: no member is left to honour the choice, so the keeper's own
    // pre-merge distance comes back.
    expect((await undoDeletes([tokenB])).restored).toBe(1);
    expect(activityRow(keep).distance_km).toBe(5);
  });
});
