// SERVER-ACTION TIER — the training-photo write path + serve route (#3285 item 3).
//
// This is the boundary no static scan can see across, so it is where the core's
// never-trust-the-client promise has to be proved: the STORED file is EXIF/GPS-free
// even when the client posts a GPS-tagged capture. Beside it, the two things a forged
// form could otherwise reach — a photo owned by nothing or by two things, and another
// profile's photo by id through the serve route.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  uploadTrainingPhotoAction,
  updateTrainingPhotoCaptionAction,
  deleteTrainingPhotoAction,
} from "@/app/(app)/training/photo-actions";
import { GET as serveTrainingPhoto } from "@/app/api/training-photo/[id]/route";
import { db } from "@/lib/db";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/__tests__/exif-fixture";
import { seedActor, createLogin, createProfile, actAs } from "./harness";

let gpsJpeg: Buffer;

beforeAll(async () => {
  const base = await sharp({
    create: {
      width: 900,
      height: 600,
      channels: 3,
      background: { r: 30, g: 90, b: 60 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  gpsJpeg = spliceExifIntoJpeg(base, {
    dateTimeOriginal: "2026:05:17 10:02:00",
    gps: true,
  });
});

async function uniqueJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: seed % 255, g: (seed * 5) % 255, b: (seed * 11) % 255 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function photoForm(
  bytes: Buffer,
  fields: Record<string, string> = {}
): FormData {
  const form = new FormData();
  form.set(
    "photo",
    new File([new Uint8Array(bytes)], "capture.jpg", { type: "image/jpeg" })
  );
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

function addActivity(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title)
         VALUES (?, '2026-05-17', 'cardio', 'Race day run')`
      )
      .run(profileId).lastInsertRowid
  );
}

function addPlan(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO endurance_plans (profile_id, kind, event_name, event_date, status)
         VALUES (?, 'race', 'Riverside Half', '2026-05-17', 'active')`
      )
      .run(profileId).lastInsertRowid
  );
}

describe("uploadTrainingPhotoAction", () => {
  it("stores metadata-free bytes even though the client sent GPS", async () => {
    const { profile } = seedActor();
    expect(readJpegExif(gpsJpeg).hasGps).toBe(true); // the fixture has teeth

    const res = await uploadTrainingPhotoAction(
      photoForm(gpsJpeg, {
        activity_id: String(addActivity(profile.id)),
        caption: "Mile 12",
      })
    );
    expect(res).toEqual({ ok: true });

    const row = db
      .prepare(
        `SELECT stored_path, thumb_path, mime_type, caption FROM training_photos
          WHERE profile_id = ?`
      )
      .get(profile.id) as {
      stored_path: string;
      thumb_path: string;
      mime_type: string;
      caption: string;
    };
    expect(row.caption).toBe("Mile 12");
    expect(row.mime_type).toBe("image/jpeg");
    for (const rel of [row.stored_path, row.thumb_path]) {
      const disk = fs.readFileSync(path.resolve(process.cwd(), rel));
      expect(readJpegExif(disk)).toMatchObject({
        hasExif: false,
        hasGps: false,
      });
    }
  });

  it.each([
    ["neither owner", {}],
    ["both owners", { both: "1" }],
  ])("refuses a form naming %s, writing nothing", async (_label, opts) => {
    const { profile } = seedActor();
    const activityId = addActivity(profile.id);
    const planId = addPlan(profile.id);
    const res = await uploadTrainingPhotoAction(
      photoForm(
        await uniqueJpeg(7),
        "both" in opts
          ? { activity_id: String(activityId), plan_id: String(planId) }
          : {}
      )
    );
    expect(res.ok).toBe(false);
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM training_photos WHERE profile_id = ?`)
        .get(profile.id)
    ).toEqual({ c: 0 });
  });

  it("refuses a read-only member and writes nothing", async () => {
    const login = createLogin();
    const profile = createProfile("Read Only", login.id);
    const activityId = addActivity(profile.id);
    actAs(login, profile, "read");
    await expect(
      uploadTrainingPhotoAction(
        photoForm(await uniqueJpeg(9), { activity_id: String(activityId) })
      )
    ).rejects.toThrow();
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM training_photos WHERE profile_id = ?`)
        .get(profile.id)
    ).toEqual({ c: 0 });
  });
});

describe("caption edit and delete are scoped to the acting profile", () => {
  it("refuses another profile's photo id, then serves and deletes its owner's", async () => {
    const mine = seedActor().profile;
    const activityId = addActivity(mine.id);
    expect(
      await uploadTrainingPhotoAction(
        photoForm(await uniqueJpeg(21), { activity_id: String(activityId) })
      )
    ).toEqual({ ok: true });
    const photoId = (
      db
        .prepare(
          `SELECT id FROM training_photos WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(mine.id) as { id: number }
    ).id;

    // A second household member acts, and reaches for the id.
    const other = seedActor().profile;
    expect(other.id).not.toBe(mine.id);
    const params = Promise.resolve({ id: String(photoId) });
    expect(
      (
        await serveTrainingPhoto(
          new Request(`http://localhost/api/training-photo/${photoId}`),
          { params }
        )
      ).status
    ).toBe(404);
    const edit = new FormData();
    edit.set("photo_id", String(photoId));
    edit.set("caption", "not theirs to write");
    expect((await updateTrainingPhotoCaptionAction(edit)).ok).toBe(false);
    const remove = new FormData();
    remove.set("photo_id", String(photoId));
    expect((await deleteTrainingPhotoAction(remove)).ok).toBe(false);

    // The owner: the full image and the thumbnail both serve, and the delete lands.
    const session = actAs(createLogin(), mine);
    expect(session.profile.id).toBe(mine.id);
    for (const url of [
      `http://localhost/api/training-photo/${photoId}`,
      `http://localhost/api/training-photo/${photoId}?thumb=1`,
    ]) {
      const served = await serveTrainingPhoto(new Request(url), {
        params: Promise.resolve({ id: String(photoId) }),
      });
      expect(served.status).toBe(200);
      expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(
        Buffer.from(await served.arrayBuffer())
          .subarray(0, 3)
          .toString("hex")
      ).toBe("ffd8ff"); // a JPEG, and the strip re-encoded it as one
    }
    expect((await deleteTrainingPhotoAction(remove)).ok).toBe(true);
  });
});
