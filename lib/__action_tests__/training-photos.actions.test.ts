// SERVER-ACTION TIER — the training-photo write path + serve route (#3285 item 3).
//
// This is the boundary no static scan can see across, so it is where the core's
// never-trust-the-client promise has to be proved: the STORED file is EXIF/GPS-free
// even when the client posts a GPS-tagged capture. Beside it, the things a forged form
// could otherwise reach — a photo owned by nothing or by two things — and the serve
// route's access rule, which has to refuse a login with no grant on the photo's owner
// while still serving one that holds a grant but is acting as a different profile.

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
    expect(res).toEqual({ ok: true, duplicate: false });

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

  // The re-upload is a success that adds nothing, and it has to SAY so. The dedup is
  // per-profile across the whole domain, so the second session is a different owner
  // and still gets no row — which is why "Photo added." over an unchanged strip was a
  // claim about something that did not happen.
  it("reports a re-upload as a duplicate, not as an add", async () => {
    const { profile } = seedActor();
    const monday = addActivity(profile.id);
    const friday = addActivity(profile.id);
    const bytes = await uniqueJpeg(31);

    expect(
      await uploadTrainingPhotoAction(
        photoForm(bytes, { activity_id: String(monday) })
      )
    ).toEqual({ ok: true, duplicate: false });
    expect(
      await uploadTrainingPhotoAction(
        photoForm(bytes, { activity_id: String(friday) })
      )
    ).toEqual({ ok: true, duplicate: true });

    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM training_photos WHERE activity_id = ?`)
        .get(friday)
    ).toEqual({ c: 0 });
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM training_photos WHERE profile_id = ?`)
        .get(profile.id)
    ).toEqual({ c: 1 });
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

// Grant an EXISTING profile to a login — the household shape `createProfile`'s own
// grant argument cannot express, since it only grants the profile it just made.
function grant(loginId: number, profileId: number, access = "write"): void {
  db.prepare(
    "INSERT OR REPLACE INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

async function attachPhoto(profileId: number, seed: number): Promise<number> {
  expect(
    await uploadTrainingPhotoAction(
      photoForm(await uniqueJpeg(seed), {
        activity_id: String(addActivity(profileId)),
      })
    )
  ).toEqual({ ok: true, duplicate: false });
  return (
    db
      .prepare(
        `SELECT id FROM training_photos WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(profileId) as { id: number }
  ).id;
}

function serve(photoId: number, thumb = false): Promise<Response> {
  return serveTrainingPhoto(
    new Request(
      `http://localhost/api/training-photo/${photoId}${thumb ? "?thumb=1" : ""}`
    ),
    { params: Promise.resolve({ id: String(photoId) }) }
  );
}

// The serve route's access rule (#1696). TrainingPhotoStrip mounts on a household
// member's activity page with `subjectProfileId` set, next to ActivityMediaStrip, so
// the tiles it emits name photos the ACTING profile does not own — the route resolves
// the owner from the row and gates the session on THAT profile. These are the three
// answers that rule has to give, and acting-profile scoping gets only the last right.
//
// ABOUT THE ACTORS: `seedActor()`/`createLogin()` mint an ADMIN by default, and admins
// are implicit-all (auth.ts accessibleProfiles), so a second seedActor() is not a
// stranger — it can reach every profile. The stranger below is a `member` login
// granted its own profile only, which is what makes the refusal mean "no grant"
// rather than "not the acting profile".
describe("the serve route resolves the photo's owner, then gates the session on it", () => {
  it("refuses a member with no grant, exactly as it refuses an id that is not there", async () => {
    const owner = seedActor().profile;
    const photoId = await attachPhoto(owner.id, 21);

    const strangerLogin = createLogin({ role: "member" });
    const strangerProfile = createProfile("Stranger", strangerLogin.id);
    actAs(strangerLogin, strangerProfile);

    for (const thumb of [false, true]) {
      const res = await serve(photoId, thumb);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "not found" });
    }
    // Refused identically to a nonexistent id: the answer says nothing about
    // whether the photo is there.
    const missing = await serve(photoId + 10_000);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: "not found" });

    // And the write paths stay shut for the same login.
    const edit = new FormData();
    edit.set("photo_id", String(photoId));
    edit.set("caption", "not theirs to write");
    expect((await updateTrainingPhotoCaptionAction(edit)).ok).toBe(false);
    const remove = new FormData();
    remove.set("photo_id", String(photoId));
    expect((await deleteTrainingPhotoAction(remove)).ok).toBe(false);
  });

  it("serves a member acting as one profile the photo owned by ANOTHER they hold", async () => {
    const subject = seedActor({ profileName: "Mia" }).profile;
    const photoId = await attachPhoto(subject.id, 22);

    // One member login, two profiles: acting as Dad, looking at Mia's page.
    const memberLogin = createLogin({ role: "member" });
    const acting = createProfile("Dad", memberLogin.id);
    grant(memberLogin.id, subject.id);
    const session = actAs(memberLogin, acting);
    expect(session.profile.id).not.toBe(subject.id);

    for (const thumb of [false, true]) {
      const res = await serve(photoId, thumb);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(
        Buffer.from(await res.arrayBuffer())
          .subarray(0, 3)
          .toString("hex")
      ).toBe("ffd8ff"); // a JPEG, and the strip re-encoded it as one
    }

    // `active_profile_id` keeps meaning the ACTING profile; the subject rides in
    // `detail`, so a cross-profile read still names whose photo it was.
    expect(
      db
        .prepare(
          `SELECT active_profile_id, detail FROM audit_events
            WHERE target = ? ORDER BY id DESC LIMIT 1`
        )
        .get(`training-photo:${photoId}:thumb`)
    ).toEqual({
      active_profile_id: acting.id,
      detail: `profile:${subject.id}`,
    });

    // A READ grant is enough to look and still not enough to write.
    grant(memberLogin.id, subject.id, "read");
    actAs(memberLogin, acting);
    expect((await serve(photoId)).status).toBe(200);
    const remove = new FormData();
    remove.set("photo_id", String(photoId));
    remove.set("profile_id", String(subject.id));
    await expect(deleteTrainingPhotoAction(remove)).rejects.toThrow();
  });

  it("serves the owner, and the owner's delete lands", async () => {
    const mine = seedActor().profile;
    const photoId = await attachPhoto(mine.id, 23);

    const session = actAs(createLogin(), mine);
    expect(session.profile.id).toBe(mine.id);
    for (const thumb of [false, true]) {
      const served = await serve(photoId, thumb);
      expect(served.status).toBe(200);
      expect(
        Buffer.from(await served.arrayBuffer())
          .subarray(0, 3)
          .toString("hex")
      ).toBe("ffd8ff");
    }

    const remove = new FormData();
    remove.set("photo_id", String(photoId));
    expect((await deleteTrainingPhotoAction(remove)).ok).toBe(true);
    // The row is gone, so the id really is nonexistent now.
    expect((await serve(photoId)).status).toBe(404);
  });
});
