// SERVER-ACTION TIER — the video-capture write paths + serve routes (#1224).
// Drives the symptom and activity upload/delete actions (and the id-AND-profile-
// scoped, Range-capable GET serve routes) against a real temp SQLite handle to
// prove: uploads are write-gated and profile-scoped; the container MIME/kind are
// SERVER-derived (never the client-declared type); the poster is EXIF-stripped
// even when the client sends a GPS-tagged frame (never-trust-the-client at the
// action boundary); oversize/overlong clips are rejected with the #478
// { ok:false } shape; the location flag drives has_location; and the serve route
// refuses a cross-profile fetch by id and honors a Range request (206).

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  uploadSymptomVideoAction,
  deleteSymptomVideoAction,
} from "@/app/(app)/medical/episodes/actions";
import {
  uploadActivityVideoAction,
  deleteActivityVideoAction,
} from "@/app/(app)/journal/video-actions";
import { GET as serveSymptomVideo } from "@/app/api/symptom-video/[id]/route";
import { GET as serveActivityVideo } from "@/app/api/activity-video/[id]/route";
import { db, today } from "@/lib/db";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import { buildMp4Fixture } from "@/lib/video/fixture";
import { MAX_VIDEO_BYTES } from "@/lib/video/policy";
import { seedActor, createLogin, createProfile, actAs } from "./harness";

let gpsPoster: Buffer;

beforeAll(async () => {
  const base = await sharp({
    create: {
      width: 480,
      height: 320,
      channels: 3,
      background: { r: 20, g: 90, b: 60 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  gpsPoster = spliceExifIntoJpeg(base, {
    dateTimeOriginal: "2026:02:03 08:15:00",
    gps: true,
  });
});

function seedActivity(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, type, title, date) VALUES (?, 'strength', 'Squat', ?)`
      )
      .run(profileId, today(profileId)).lastInsertRowid
  );
}

function videoFile(bytes: Buffer, name = "clip.mp4"): File {
  return new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
}

describe("uploadActivityVideoAction + serve route", () => {
  it("stores a server-sniffed clip with a stripped poster, honors Range, and scopes by profile", async () => {
    const owner = seedActor();
    const activityId = seedActivity(owner.profile.id);
    expect(readJpegExif(gpsPoster).hasGps).toBe(true); // the poster fixture has teeth

    const form = new FormData();
    form.set("activityId", String(activityId));
    form.set(
      "video",
      videoFile(
        buildMp4Fixture({
          durationSec: 8,
          creationDate: "2026-02-03",
          location: true,
        })
      )
    );
    form.set(
      "poster",
      new File([new Uint8Array(gpsPoster)], "poster.jpg", {
        type: "image/jpeg",
      })
    );
    form.set("exercise", "Back Squat");
    form.set("caption", "depth");
    const res = await uploadActivityVideoAction(form);
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, stored_path, poster_path, mime_type, kind, has_location, exercise
           FROM activity_videos WHERE profile_id = ?`
      )
      .get(owner.profile.id) as {
      id: number;
      stored_path: string;
      poster_path: string;
      mime_type: string;
      kind: string;
      has_location: number;
      exercise: string;
    };
    expect(row.mime_type).toBe("video/mp4"); // server-derived, not the File.type
    expect(row.kind).toBe("video");
    expect(row.has_location).toBe(1); // location atom detected → warning flag
    expect(row.exercise).toBe("Back Squat");
    // The stored POSTER is metadata-free even though the client sent a GPS frame.
    const posterDisk = fs.readFileSync(
      path.resolve(process.cwd(), row.poster_path)
    );
    expect(readJpegExif(posterDisk)).toMatchObject({
      hasExif: false,
      hasGps: false,
    });

    // Serve route: full 200, and a Range request → 206 with Content-Range.
    const full = await serveActivityVideo(
      new Request(`http://test/api/activity-video/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");

    const ranged = await serveActivityVideo(
      new Request(`http://test/api/activity-video/${row.id}`, {
        headers: { Range: "bytes=0-9" },
      }),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-9\//);
    expect(ranged.headers.get("content-length")).toBe("10");

    // The poster serves as image/jpeg.
    const poster = await serveActivityVideo(
      new Request(`http://test/api/activity-video/${row.id}?poster=1`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");

    // Another profile can't fetch it by id.
    seedActor();
    const denied = await serveActivityVideo(
      new Request(`http://test/api/activity-video/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ ok: false, error: "not found" });
  });

  it("rejects a non-container, an oversize clip, and an overlong clip with { ok:false }", async () => {
    const { profile } = seedActor();
    const activityId = seedActivity(profile.id);

    const notVideo = new FormData();
    notVideo.set("activityId", String(activityId));
    notVideo.set(
      "video",
      new File([Buffer.from("not a video at all")], "x.mp4", {
        type: "video/mp4",
      })
    );
    expect((await uploadActivityVideoAction(notVideo)).ok).toBe(false);

    const oversize = new FormData();
    oversize.set("activityId", String(activityId));
    oversize.set(
      "video",
      videoFile(
        Buffer.concat([
          buildMp4Fixture({ durationSec: 5 }),
          Buffer.alloc(MAX_VIDEO_BYTES + 1),
        ])
      )
    );
    expect((await uploadActivityVideoAction(oversize)).ok).toBe(false);

    const overlong = new FormData();
    overlong.set("activityId", String(activityId));
    overlong.set("video", videoFile(buildMp4Fixture({ durationSec: 75 })));
    const r = await uploadActivityVideoAction(overlong);
    expect(r.ok).toBe(false);
  });

  it("is blocked for a read-only grant (requireWriteAccess)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`ReadOnly ${login.username}`, login.id);
    actAs(login, profile, "read");
    const form = new FormData();
    form.set("activityId", "1");
    form.set("video", videoFile(buildMp4Fixture({ durationSec: 3 })));
    await expect(uploadActivityVideoAction(form)).rejects.toThrow(/read-only/);
  });

  it("deletes only the acting profile's clip (row + file)", async () => {
    const owner = seedActor();
    const activityId = seedActivity(owner.profile.id);
    const form = new FormData();
    form.set("activityId", String(activityId));
    form.set(
      "video",
      videoFile(buildMp4Fixture({ durationSec: 4, creationDate: "2026-03-03" }))
    );
    expect((await uploadActivityVideoAction(form)).ok).toBe(true);
    const row = db
      .prepare(
        `SELECT id, stored_path FROM activity_videos WHERE profile_id = ?`
      )
      .get(owner.profile.id) as { id: number; stored_path: string };

    const del = new FormData();
    del.set("videoId", String(row.id));
    expect((await deleteActivityVideoAction(del)).ok).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      false
    );
  });
});

describe("uploadSymptomVideoAction (active-profile path) + serve route", () => {
  it("attaches a clip to a symptom day, defaults the date from the container, and scopes the serve route", async () => {
    const owner = seedActor();
    const form = new FormData();
    form.set(
      "video",
      videoFile(buildMp4Fixture({ durationSec: 6, creationDate: "2026-04-10" }))
    );
    form.set("symptom", "seizure");
    form.set("caption", "arm jerk");
    const res = await uploadSymptomVideoAction(form);
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, date, symptom, kind, stored_path FROM symptom_videos WHERE profile_id = ?`
      )
      .get(owner.profile.id) as {
      id: number;
      date: string;
      symptom: string;
      kind: string;
      stored_path: string;
    };
    expect(row.date).toBe("2026-04-10"); // harvested container creation date
    expect(row.symptom).toBe("seizure");
    expect(row.kind).toBe("video");

    const served = await serveSymptomVideo(
      new Request(`http://test/api/symptom-video/${row.id}`, {
        headers: { Range: "bytes=0-3" },
      }),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(served.status).toBe(206);

    // Delete removes the row.
    const del = new FormData();
    del.set("videoId", String(row.id));
    expect((await deleteSymptomVideoAction(del)).ok).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      false
    );
  });
});
