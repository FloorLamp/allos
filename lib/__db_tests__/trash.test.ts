// DB INTEGRATION TIER — Data → Trash (issue #2013).
//
// The pure suite (lib/__tests__/trash.test.ts) covers the derivation. This file opens
// a real (temp) SQLite handle and proves what a Trash has to get right and a
// 15-second toast never had to:
//
//   1. the retention sweep honours the CONFIGURED window rather than a hardcoded day;
//   2. restoring from the Trash is the SAME core as the toast's undo (one restore
//      path, not two that can drift);
//   3. "Delete permanently" removes exactly that capture — and Empty trash clears
//      only the ACTING profile's, leaving a household member's captures standing;
//   4. a bulk correction, which shares the table but is an inverted EDIT, is neither
//      listed nor swept up by either by-hand purge;
//   5. deleting the PROFILE reclaims the media its captures still hold (#5957) — it
//      destroys them through a table sweep rather than a purge, so it is the path
//      that can drop a holding row without reclaiming what the row pointed at;
//   6. a purge unlinks only files inside the purging profile's own directory
//      (#5997), whatever path its capture names.
//
// The rest of the clip-file half (a purge must unlink the captured video files) lives
// in lib/__db_tests__/video-write.test.ts, where the video fixtures already are.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, today } from "@/lib/db";
import {
  captureDelete,
  emptyTrash,
  purgeDeletedRow,
  restoreDeletedRow,
  sweepDeletedRows,
} from "@/lib/undo-delete-db";
import { listTrash, countTrash } from "@/lib/queries/trash";
import { getTrashRetentionDays, setTrashRetentionDays } from "@/lib/settings";
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
} from "@/lib/retention";
import { BULK_CORRECTION_KIND } from "@/lib/bulk-correction";
import {
  storeVideoFiles,
  unlinkVideoFiles,
  videoDomainRoot,
} from "@/lib/video/store";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import {
  actAs,
  createLogin,
  createProfile,
  fd,
} from "../__action_tests__/harness";
import { seedProfile, type SeededProfile } from "./fixtures";
import type { WriteAuthorizedProfileId } from "@/lib/auth";

// The cores this file drives take the id a write gate minted (#5348). A test seeds its
// own profiles, so there is no gate return to pass on: it casts — once, here, rather than
// at each call site. WRITE_BRAND_CAST (eslint.config.mjs) binds production modules; the
// test tiers are deliberately exempt, the same allowance RPE_BRAND_CAST makes.
function gated(profileId: number): WriteAuthorizedProfileId {
  return profileId as WriteAuthorizedProfileId;
}

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("TRASH");
});

// A throwaway activity this test owns, so nothing here counts shared fixture rows.
function newActivity(profileId: number, title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title)
         VALUES (?, ?, 'cardio', ?)`
      )
      .run(profileId, today(profileId), title).lastInsertRowid
  );
}

const backdate = (undoId: number, modifier: string) =>
  db
    .prepare(
      `UPDATE deleted_rows SET deleted_at = datetime('now', ?) WHERE id = ?`
    )
    .run(modifier, undoId);

const holdingRows = (undoId: number) =>
  (
    db
      .prepare(`SELECT COUNT(*) c FROM deleted_rows WHERE id = ?`)
      .get(undoId) as { c: number }
  ).c;

describe("the retention window is a setting, not a constant", () => {
  it("defaults to 30 days and round-trips a clamped admin value", () => {
    expect(getTrashRetentionDays()).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    setTrashRetentionDays(7);
    expect(getTrashRetentionDays()).toBe(7);
    // Out of range is clamped on the way in, so a hand-edited settings row can never
    // disable or unbound the sweep.
    setTrashRetentionDays(9_999);
    expect(getTrashRetentionDays()).toBe(MAX_TRASH_RETENTION_DAYS);
    setTrashRetentionDays(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it("sweeps against the window it is GIVEN, in days", () => {
    const act = newActivity(p.profileId, "TRASH sweep window");
    const undoId = captureDelete("activity", p.profileId, act)!;
    expect(undoId).toBeTruthy();

    // Ten days old: under the 30-day default it survives — which is the whole point
    // of the feature, because under the old hardcoded day it would already be gone.
    backdate(undoId, "-10 days");
    sweepDeletedRows(DEFAULT_TRASH_RETENTION_DAYS);
    expect(holdingRows(undoId)).toBe(1);

    // The same row, the same age, a tighter admin-configured window → purged.
    expect(sweepDeletedRows(7)).toBeGreaterThanOrEqual(1);
    expect(holdingRows(undoId)).toBe(0);
  });
});

describe("listing the trash", () => {
  it("renders a capture with the payload's identifying content, newest first", () => {
    const older = newActivity(p.profileId, "TRASH list older");
    const olderUndo = captureDelete("activity", p.profileId, older)!;
    backdate(olderUndo, "-3 days");
    const newer = newActivity(p.profileId, "TRASH list newer");
    const newerUndo = captureDelete("activity", p.profileId, newer)!;

    const entries = listTrash(p.profileId, DEFAULT_TRASH_RETENTION_DAYS);
    const mine = entries.filter((e) => e.title?.startsWith("TRASH list"));
    expect(mine.map((e) => e.title)).toEqual([
      "TRASH list newer",
      "TRASH list older",
    ]);
    // The label column alone would say "activity" for both.
    expect(mine[0].label).toBe("activity");
    expect(mine[0].id).toBe(newerUndo);
    expect(mine[1].expiresInDays).toBeLessThan(mine[0].expiresInDays);

    purgeDeletedRow(gated(p.profileId), olderUndo);
    purgeDeletedRow(gated(p.profileId), newerUndo);
  });

  it("never surfaces another profile's captures", () => {
    const other = seedProfile("TRASH-OTHER");
    const act = newActivity(other.profileId, "TRASH-OTHER private");
    const undoId = captureDelete("activity", other.profileId, act)!;

    expect(listTrash(p.profileId, 30).map((e) => e.id)).not.toContain(undoId);
    expect(listTrash(other.profileId, 30).map((e) => e.id)).toContain(undoId);

    purgeDeletedRow(gated(other.profileId), undoId);
  });
});

describe("restore from the Trash is the same core as undo", () => {
  it("puts the row and its children back through restoreDeletedRow", () => {
    const setsBefore = (
      db
        .prepare(`SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?`)
        .get(p.strengthActivityId) as { c: number }
    ).c;
    expect(setsBefore).toBe(2);

    const undoId = captureDelete(
      "activity",
      p.profileId,
      p.strengthActivityId
    )!;
    // It is visible in the Trash — the state that had no affordance before #2013.
    const entry = listTrash(p.profileId, 30).find((e) => e.id === undoId);
    expect(entry?.title).toBe(`${p.tag} Strength Day`);
    expect(entry?.childCount).toBe(setsBefore);

    // The Trash's Restore button calls undoDelete, which calls exactly this.
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);

    const restored = db
      .prepare(`SELECT id FROM activities WHERE profile_id = ? AND title = ?`)
      .get(p.profileId, `${p.tag} Strength Day`) as { id: number };
    expect(restored).toBeTruthy();
    // New id (restore never re-uses the deleted row's), children intact.
    expect(restored.id).not.toBe(p.strengthActivityId);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?`)
          .get(restored.id) as { c: number }
      ).c
    ).toBe(setsBefore);
    // The capture is consumed, so the Trash no longer offers it.
    expect(listTrash(p.profileId, 30).map((e) => e.id)).not.toContain(undoId);
  });
});

describe("delete permanently", () => {
  it("removes exactly that capture and reports a typed outcome", () => {
    const keep = newActivity(p.profileId, "TRASH purge keeper");
    const keepUndo = captureDelete("activity", p.profileId, keep)!;
    const drop = newActivity(p.profileId, "TRASH purge target");
    const dropUndo = captureDelete("activity", p.profileId, drop)!;

    expect(purgeDeletedRow(gated(p.profileId), dropUndo)).toEqual({
      kind: "purged",
    });
    expect(holdingRows(dropUndo)).toBe(0);
    expect(holdingRows(keepUndo)).toBe(1);

    // A second tap (or another tab's) is "gone", not a second purge — the surface
    // must not report a write it did not perform.
    expect(purgeDeletedRow(gated(p.profileId), dropUndo)).toEqual({
      kind: "gone",
    });

    purgeDeletedRow(gated(p.profileId), keepUndo);
  });

  it("refuses another profile's token", () => {
    const other = seedProfile("TRASH-PURGE-OTHER");
    const act = newActivity(other.profileId, "TRASH-PURGE-OTHER row");
    const undoId = captureDelete("activity", other.profileId, act)!;

    expect(purgeDeletedRow(gated(p.profileId), undoId)).toEqual({
      kind: "gone",
    });
    expect(holdingRows(undoId)).toBe(1);
    // The rightful owner can.
    expect(purgeDeletedRow(gated(other.profileId), undoId)).toEqual({
      kind: "purged",
    });
  });

  it("a purged capture is unrestorable — the point of 'permanently'", () => {
    const act = newActivity(p.profileId, "TRASH purge unrestorable");
    const undoId = captureDelete("activity", p.profileId, act)!;
    expect(purgeDeletedRow(gated(p.profileId), undoId)).toEqual({
      kind: "purged",
    });
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(false);
  });
});

describe("empty trash", () => {
  it("clears the acting profile's captures and leaves another profile's intact", () => {
    const mine = seedProfile("TRASH-EMPTY-MINE");
    const theirs = seedProfile("TRASH-EMPTY-THEIRS");

    const mineUndos = ["a", "b"].map((n) =>
      captureDelete(
        "activity",
        mine.profileId,
        newActivity(mine.profileId, `TRASH-EMPTY-MINE ${n}`)
      )!
    );
    const theirUndo = captureDelete(
      "activity",
      theirs.profileId,
      newActivity(theirs.profileId, "TRASH-EMPTY-THEIRS a")
    )!;

    expect(countTrash(mine.profileId)).toBe(2);
    expect(emptyTrash(gated(mine.profileId))).toBe(2);

    expect(countTrash(mine.profileId)).toBe(0);
    for (const id of mineUndos) expect(holdingRows(id)).toBe(0);
    // The sweep is global instance maintenance; THIS is one person clearing theirs.
    expect(holdingRows(theirUndo)).toBe(1);
    expect(countTrash(theirs.profileId)).toBe(1);

    // Emptying an empty trash purges nothing, and says so.
    expect(emptyTrash(gated(mine.profileId))).toBe(0);

    purgeDeletedRow(gated(theirs.profileId), theirUndo);
  });
});

describe("a bulk correction shares the table but is not a deleted row", () => {
  // #1603 snapshots the INVERSE OF AN EDIT into deleted_rows to reuse the purge
  // timer. Its undo is undoBulkCorrection, not restoreDeletedRow, and it has its own
  // affordance on Data → Review — so the Trash must neither offer it a Restore button
  // that cannot work nor destroy it under "Empty trash".
  function seedCorrection(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO deleted_rows (profile_id, kind, label, payload)
           VALUES (?, ?, 'bulk correction', ?)`
        )
        .run(
          profileId,
          BULK_CORRECTION_KIND,
          JSON.stringify({ v: 1, field: "weight", changes: [] })
        ).lastInsertRowid
    );
  }

  it("is excluded from the list, the count, and both by-hand purges", () => {
    const owner = seedProfile("TRASH-BULK");
    const correctionId = seedCorrection(owner.profileId);
    const deleteUndo = captureDelete(
      "activity",
      owner.profileId,
      newActivity(owner.profileId, "TRASH-BULK deleted row")
    )!;

    expect(listTrash(owner.profileId, 30).map((e) => e.id)).toEqual([
      deleteUndo,
    ]);
    expect(countTrash(owner.profileId)).toBe(1);

    // Neither purge touches it.
    expect(purgeDeletedRow(gated(owner.profileId), correctionId)).toEqual({
      kind: "gone",
    });
    expect(emptyTrash(gated(owner.profileId))).toBe(1);
    expect(holdingRows(correctionId)).toBe(1);

    // The GLOBAL expiry sweep still takes it, on its own schedule.
    backdate(correctionId, "-2 days");
    sweepDeletedRows(1);
    expect(holdingRows(correctionId)).toBe(0);
  });
});

describe("deleting a profile reclaims the media its Trash still holds", () => {
  // #5957: a row deleted through Trash is gone from symptom_videos / activity_videos,
  // so deleteProfile's live-table path collection cannot see it — its clip and poster
  // are named only inside the capture's payload, and the OWNED_TABLES sweep removes
  // that capture without reading it. The files then sit under data/uploads with
  // nothing in the database pointing at them: a right-to-delete residue, not a
  // display defect. The reclaim itself is the Trash purges' own, so what is proved
  // here is that the profile delete REACHES it.
  const abs = (rel: string) => path.resolve(process.cwd(), rel);

  // A profile with one activity whose clip + poster are on disk, captured into Trash.
  // Returns the two absolute paths the capture now exclusively names.
  function captureClipIntoTrash(
    profileId: number,
    tag: string
  ): { clip: string; poster: string } {
    const act = newActivity(profileId, `${tag} clip owner`);
    const stored = storeVideoFiles("activity", profileId, {
      contentHash: `hash-${tag}`,
      mime: "video/mp4",
      bytes: Buffer.from(`clip-${tag}`),
      poster: Buffer.from(`poster-${tag}`),
    });
    expect(stored.posterPath).toBeTruthy();
    db.prepare(
      `INSERT INTO activity_videos
         (profile_id, activity_id, stored_path, poster_path, content_hash, mime_type)
       VALUES (?, ?, ?, ?, ?, 'video/mp4')`
    ).run(profileId, act, stored.storedPath, stored.posterPath, `hash-${tag}`);
    expect(captureDelete("activity", profileId, act)).toBeTruthy();
    // The delete+undo window deliberately leaves the files standing, and the live
    // table no longer names them — the state the profile delete has to handle.
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM activity_videos WHERE profile_id = ?`)
        .get(profileId)
    ).toEqual({ c: 0 });
    return { clip: abs(stored.storedPath), poster: abs(stored.posterPath!) };
  }

  it("unlinks a captured clip and poster, and leaves another profile's alone", async () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("TRASH-DELPROF Admin");
    const victim = createProfile("TRASH-DELPROF Victim");
    const bystander = createProfile("TRASH-DELPROF Bystander");
    actAs(admin, acting);

    const victimFiles = captureClipIntoTrash(victim.id, "victim");
    // POSITIVE CONTROL: an identical capture on a profile that is NOT deleted. Its
    // files must still be on disk after the delete, so an assertion that can only
    // ever report "missing" cannot pass this test.
    const bystanderFiles = captureClipIntoTrash(bystander.id, "bystander");

    expect(fs.existsSync(victimFiles.clip)).toBe(true);
    expect(fs.existsSync(victimFiles.poster)).toBe(true);

    const res = await deleteProfile(fd({ id: victim.id }));
    expect(res.ok).toBe(true);
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM deleted_rows WHERE profile_id = ?`)
        .get(victim.id)
    ).toEqual({ c: 0 });

    expect(fs.existsSync(victimFiles.clip)).toBe(false);
    expect(fs.existsSync(victimFiles.poster)).toBe(false);
    expect(fs.existsSync(bystanderFiles.clip)).toBe(true);
    expect(fs.existsSync(bystanderFiles.poster)).toBe(true);

    // The bystander's own Trash still reclaims them, unchanged by any of this.
    emptyTrash(gated(bystander.id));
    expect(fs.existsSync(bystanderFiles.clip)).toBe(false);
    expect(fs.existsSync(bystanderFiles.poster)).toBe(false);
  });
});

describe("a purge unlinks only the purging profile's own files", () => {
  // #5997: containment used to be the domain root, so a capture naming a path under
  // another profile's directory destroyed that file — and the still-live probe cannot
  // protect a row that is itself in the Trash.
  const abs = (rel: string) => path.resolve(process.cwd(), rel);

  function clip(profileId: number, tag: string) {
    const stored = storeVideoFiles("activity", profileId, {
      contentHash: `hash-${tag}`,
      mime: "video/mp4",
      bytes: Buffer.from(`clip-${tag}`),
      poster: null,
    });
    return stored.storedPath;
  }

  function linkVideo(profileId: number, activityId: number, stored: string) {
    db.prepare(
      `INSERT INTO activity_videos
         (profile_id, activity_id, stored_path, content_hash, mime_type)
       VALUES (?, ?, ?, ?, 'video/mp4')`
    ).run(profileId, activityId, stored, `row-${stored}`);
  }

  it("leaves another profile's trashed clip that a capture names", () => {
    const a = createProfile("TRASH-CONTAIN A").id;
    const b = createProfile("TRASH-CONTAIN B").id;

    // B's clip, with B's own row in the Trash so no live row protects it.
    const bActivity = newActivity(b, "B clip owner");
    const bPath = clip(b, "contain-b");
    linkVideo(b, bActivity, bPath);
    expect(captureDelete("activity", b, bActivity)).toBeTruthy();

    // A's capture names its own clip AND B's path.
    const aActivity = newActivity(a, "A clip owner");
    const aPath = clip(a, "contain-a");
    linkVideo(a, aActivity, aPath);
    linkVideo(a, aActivity, bPath);
    const undoId = captureDelete("activity", a, aActivity);
    expect(undoId).toBeTruthy();

    expect(purgeDeletedRow(gated(a), undoId!)).toEqual({ kind: "purged" });
    expect(fs.existsSync(abs(aPath))).toBe(false);
    expect(fs.existsSync(abs(bPath))).toBe(true);
  });

  it("refuses a traversal, an absolute path, or a symlink out of the profile's dir", () => {
    const a = createProfile("TRASH-TRAVERSE A").id;
    const b = createProfile("TRASH-TRAVERSE B").id;
    const bPath = abs(clip(b, "traverse-b"));
    const aDir = path.join(videoDomainRoot("activity"), String(a));
    fs.mkdirSync(aDir, { recursive: true });
    fs.symlinkSync(path.dirname(bPath), path.join(aDir, "link"));
    const name = path.basename(bPath);

    unlinkVideoFiles("activity", a, [
      path.join(
        "data/uploads/activity-videos",
        String(a),
        "..",
        String(b),
        name
      ),
      bPath,
      path.join(aDir, "link", name),
    ]);
    expect(fs.existsSync(bPath)).toBe(true);

    fs.rmSync(aDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(bPath), { recursive: true, force: true });
  });
});
