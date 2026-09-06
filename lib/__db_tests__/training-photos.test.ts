// DB INTEGRATION TIER — training photos (#3285 item 3), the shared photo core's
// fourth tenant.
//
// What only this tier can see: the exactly-one-owner CHECK against the real migrated
// schema, the per-profile dedup across BOTH owners, the derived (never stored) date
// coming off the owner row, the event's union read over its own uploads plus its
// linked sessions', the two delete paths (a photo delete and a plan delete both take
// their files with them, an activity delete does NOT because it is undoable), and the
// media counts the record's Photos filter is a predicate on.
//
// SYNTHETIC ONLY: fictional profiles, invented titles, one-byte "images" written
// straight to the store's own paths — the ingest pipeline is proved at the action
// tier, where the client's bytes actually arrive.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { photoDomainRoot } from "@/lib/photo/store";
import type { ProcessedPhoto } from "@/lib/photo/ingest";
import {
  addTrainingPhotoCore,
  deleteTrainingPhotoCore,
  getActivityPhotos,
  getEventPhotos,
  trainingPhotoCounts,
  updateTrainingPhotoCaptionCore,
} from "@/lib/training-photo-write";
import {
  createEndurancePlanCore,
  deleteEndurancePlanCore,
  linkEventActivityCore,
} from "@/lib/endurance-plans";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import { getTimelineEvents } from "@/lib/timeline";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The plan id, or a failure the fixture must not swallow.
function planFor(profileId: number, name: string, date: string): number {
  const made = createEndurancePlanCore(profileId, {
    kind: "race",
    eventName: name,
    eventDate: date,
  });
  if (made.kind !== "ok") throw new Error(`plan not created: ${made.kind}`);
  return made.id;
}

function addActivity(profileId: number, date: string, title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'cardio', ?, 42)`
      )
      .run(profileId, date, title).lastInsertRowid
  );
}

// A ProcessedPhoto as the ingest hands one over. `seed` varies the content hash, which
// is the only field the dedup and the file naming read.
function processed(seed: string): ProcessedPhoto {
  return {
    bytes: Buffer.from(`photo bytes ${seed}`),
    thumbBytes: Buffer.from(`thumb bytes ${seed}`),
    mime: "image/jpeg",
    width: 800,
    height: 600,
    sizeBytes: 20 + seed.length,
    contentHash: `hash ${seed} 41`.replace(/\s/g, "0"),
    captureDate: null,
  };
}

const EVENT_DAY = "2026-05-17";
let owner: number;
let stranger: number;
let raceRunId: number;
let otherSessionId: number;
let planId: number;

beforeAll(() => {
  owner = makeProfile("PHOTOS-OWNER");
  stranger = makeProfile("PHOTOS-STRANGER");
  raceRunId = addActivity(owner, EVENT_DAY, "Race day run");
  otherSessionId = addActivity(owner, "2026-05-10", "Tuesday tempo");
  planId = planFor(owner, "Riverside Half", EVENT_DAY);
  expect(linkEventActivityCore(owner, planId, raceRunId)).toBe(true);
});

describe("the owner is exactly one of a session or an event", () => {
  it("refuses a row with no owner, and one with both, at the schema", () => {
    const both = () =>
      db
        .prepare(
          `INSERT INTO training_photos
             (profile_id, activity_id, endurance_plan_id, stored_path, content_hash)
           VALUES (?, ?, ?, 'x', 'forged-both')`
        )
        .run(owner, raceRunId, planId);
    const neither = () =>
      db
        .prepare(
          `INSERT INTO training_photos
             (profile_id, stored_path, content_hash) VALUES (?, 'x', 'forged-none')`
        )
        .run(owner);
    expect(both).toThrow(/CHECK/i);
    expect(neither).toThrow(/CHECK/i);
  });

  it("refuses another profile's session or event before writing anything", () => {
    const before = trainingPhotoCounts(stranger);
    const onMySession = addTrainingPhotoCore(
      stranger,
      { kind: "activity", activityId: raceRunId },
      processed("stranger a")
    );
    const onMyEvent = addTrainingPhotoCore(
      stranger,
      { kind: "event", planId },
      processed("stranger b")
    );
    expect(onMySession.kind).toBe("invalid");
    expect(onMyEvent.kind).toBe("invalid");
    expect(trainingPhotoCounts(stranger)).toEqual(before);
  });
});

describe("attach, dedup and read", () => {
  it("stores the file + thumbnail and derives the date from the owner", () => {
    const res = addTrainingPhotoCore(
      owner,
      { kind: "activity", activityId: raceRunId },
      processed("run one"),
      "  Mile 12  "
    );
    expect(res).toMatchObject({ kind: "added" });

    const [row] = getActivityPhotos(owner, raceRunId);
    // The date is the SESSION's — no date column exists to disagree with it.
    expect(row).toMatchObject({
      date: EVENT_DAY,
      ownerLabel: "Race day run",
      caption: "Mile 12",
      planId: null,
    });

    const paths = db
      .prepare(
        `SELECT stored_path, thumb_path FROM training_photos WHERE id = ?`
      )
      .get(row.id) as { stored_path: string; thumb_path: string };
    const root = path.resolve(photoDomainRoot("training"), String(owner));
    for (const rel of [paths.stored_path, paths.thumb_path]) {
      const abs = path.resolve(process.cwd(), rel);
      expect(abs.startsWith(root + path.sep)).toBe(true);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });

  it("dedups per profile ACROSS both owners — one photograph, one row", () => {
    const bytes = processed("shared capture");
    const first = addTrainingPhotoCore(owner, { kind: "event", planId }, bytes);
    expect(first.kind).toBe("added");
    // The same bytes offered to the OTHER owner kind: not a second row, and not a
    // second file. The event page already shows its linked sessions' photos, so
    // there is nowhere a second copy would be visible that this one is not.
    const again = addTrainingPhotoCore(
      owner,
      { kind: "activity", activityId: raceRunId },
      bytes
    );
    expect(again).toEqual({
      kind: "duplicate",
      id: (first as { id: number }).id,
    });
  });

  it("an event reads its OWN uploads and its LINKED sessions', its own first", () => {
    addTrainingPhotoCore(owner, { kind: "event", planId }, processed("podium"));
    addTrainingPhotoCore(
      owner,
      { kind: "activity", activityId: otherSessionId },
      processed("tuesday")
    );

    const shown = getEventPhotos(owner, planId);
    expect(shown.every((p) => p.date === EVENT_DAY)).toBe(true);
    // The unlinked Tuesday session's photo is NOT the event's.
    expect(shown.map((p) => p.ownerLabel)).not.toContain("Tuesday tempo");
    expect(shown.some((p) => p.ownerLabel === "Race day run")).toBe(true);
    // Own uploads sort ahead of the linked sessions'.
    const firstActivityAt = shown.findIndex((p) => p.activityId != null);
    const lastEventAt = shown.map((p) => p.planId != null).lastIndexOf(true);
    expect(lastEventAt).toBeLessThan(firstActivityAt);
  });

  it("corrects the caption without touching the bytes (#1934)", () => {
    const [row] = getActivityPhotos(owner, raceRunId);
    const before = db
      .prepare(
        `SELECT stored_path, thumb_path, content_hash FROM training_photos WHERE id = ?`
      )
      .get(row.id);
    expect(updateTrainingPhotoCaptionCore(owner, row.id, "Mile 13")).toBe(true);
    // Another profile cannot reach it by id.
    expect(updateTrainingPhotoCaptionCore(stranger, row.id, "theirs")).toBe(
      false
    );
    expect(getActivityPhotos(owner, raceRunId)[0].caption).toBe("Mile 13");
    expect(
      db
        .prepare(
          `SELECT stored_path, thumb_path, content_hash FROM training_photos WHERE id = ?`
        )
        .get(row.id)
    ).toEqual(before);
  });
});

describe("the record's Photos filter counts sessions and events apart", () => {
  it("counts each owner's own photos, never one photo twice", () => {
    const counts = trainingPhotoCounts(owner);
    const rows = db
      .prepare(`SELECT COUNT(*) c FROM training_photos WHERE profile_id = ?`)
      .get(owner) as { c: number };
    const summed = [
      ...counts.byActivity.values(),
      ...counts.byEvent.values(),
    ].reduce((a, b) => a + b, 0);
    expect(summed).toBe(rows.c);
    expect(counts.byActivity.get(raceRunId)).toBeGreaterThan(0);
    expect(counts.byEvent.get(planId)).toBeGreaterThan(0);
  });

  it("reaches the feed rows, which every composer used to write as 0", () => {
    const events = getTimelineEvents(owner, {});
    const session = events.find((e) => e.id === `activity:${raceRunId}`);
    const event = events.find((e) => e.id === `endurance:${planId}:event`);
    expect(session?.media).toBe(
      trainingPhotoCounts(owner).byActivity.get(raceRunId)
    );
    expect(event?.media).toBe(trainingPhotoCounts(owner).byEvent.get(planId));
    // The control: a session with no photos still reports a number, not undefined.
    const quiet = events.find((e) => e.id === `activity:${otherSessionId}`);
    expect(quiet?.media).toBe(1);
  });
});

describe("deletes take the right files with them", () => {
  it("a photo delete removes the row and both files; a stranger's id does not", () => {
    const gone = makeProfile("PHOTOS-DELETE");
    const act = addActivity(gone, "2026-04-02", "Hill repeats");
    const added = addTrainingPhotoCore(
      gone,
      { kind: "activity", activityId: act },
      processed("to delete")
    ) as { kind: "added"; id: number };
    const paths = db
      .prepare(
        `SELECT stored_path, thumb_path FROM training_photos WHERE id = ?`
      )
      .get(added.id) as { stored_path: string; thumb_path: string };

    expect(deleteTrainingPhotoCore(owner, added.id)).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), paths.stored_path))).toBe(
      true
    );

    expect(deleteTrainingPhotoCore(gone, added.id)).toBe(true);
    expect(getActivityPhotos(gone, act)).toEqual([]);
    for (const rel of [paths.stored_path, paths.thumb_path])
      expect(fs.existsSync(path.resolve(process.cwd(), rel))).toBe(false);
    // Idempotent.
    expect(deleteTrainingPhotoCore(gone, added.id)).toBe(false);
  });

  it("deleting an event takes its OWN photos and leaves its sessions'", () => {
    const p = makeProfile("PHOTOS-PLAN-DELETE");
    const run = addActivity(p, "2026-06-07", "Marathon");
    const plan = planFor(p, "City Marathon", "2026-06-07");
    expect(linkEventActivityCore(p, plan, run)).toBe(true);
    const bib = addTrainingPhotoCore(
      p,
      { kind: "event", planId: plan },
      processed("bib pinned")
    ) as { kind: "added"; id: number };
    const onRun = addTrainingPhotoCore(
      p,
      { kind: "activity", activityId: run },
      processed("finish line")
    ) as { kind: "added"; id: number };
    const bibPath = (
      db
        .prepare(`SELECT stored_path FROM training_photos WHERE id = ?`)
        .get(bib.id) as { stored_path: string }
    ).stored_path;

    expect(deleteEndurancePlanCore(p, plan)).toBe(true);
    // The event's own picture is gone, file and all — it had no other home.
    expect(
      db.prepare(`SELECT 1 FROM training_photos WHERE id = ?`).get(bib.id)
    ).toBeUndefined();
    expect(fs.existsSync(path.resolve(process.cwd(), bibPath))).toBe(false);
    // The session's picture outlives the plan exactly as the session does.
    expect(getActivityPhotos(p, run).map((r) => r.id)).toEqual([onRun.id]);
  });

  it("an activity delete is undoable, and its photos come back with it", () => {
    const p = makeProfile("PHOTOS-UNDO");
    const act = addActivity(p, "2026-03-08", "Long ride");
    const added = addTrainingPhotoCore(
      p,
      { kind: "activity", activityId: act },
      processed("summit"),
      "At the top"
    ) as { kind: "added"; id: number };
    const rel = (
      db
        .prepare(`SELECT stored_path FROM training_photos WHERE id = ?`)
        .get(added.id) as { stored_path: string }
    ).stored_path;

    const token = captureDelete("activity", p, act)!;
    expect(token).toBeTruthy();
    expect(getActivityPhotos(p, act)).toEqual([]);
    // The FILE survives the window untouched — that is what makes the restore whole.
    expect(fs.existsSync(path.resolve(process.cwd(), rel))).toBe(true);

    expect(restoreDeletedRow(p, token)).toBe(true);
    // A restore re-inserts, so the session comes back under a NEW id and the photo's
    // activity_id is remapped onto it — that remap is the whole reason the photo has
    // to be a captured entity rather than a cascade nobody wrote down.
    const restored = db
      .prepare(
        `SELECT id FROM activities WHERE profile_id = ? AND title = 'Long ride'`
      )
      .get(p) as { id: number };
    expect(restored.id).not.toBe(act);
    const back = getActivityPhotos(p, restored.id);
    expect(back).toHaveLength(1);
    expect(back[0].caption).toBe("At the top");
    expect(fs.existsSync(path.resolve(process.cwd(), rel))).toBe(true);
  });
});
