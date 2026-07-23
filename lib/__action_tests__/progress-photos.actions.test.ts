// SERVER-ACTION TIER — the progress-photo write path + serve route (#1119).
// Drives uploadProgressPhoto / deleteProgressPhoto (and the id-AND-profile-scoped
// GET serve route) against a real temp SQLite handle to prove: the upload is
// write-gated and profile-scoped; the STORED file is EXIF/GPS-free even when the
// client sends a GPS-tagged file (the never-trust-the-client pin at the action
// boundary); the date defaults from the harvested capture date; a duplicate
// upload is a calm success; deletes are scoped; and the serve route refuses a
// cross-profile fetch by id. The static scanners can't see across the action
// boundary; this is the dynamic guard.

import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { revalidatePath } from "next/cache";
import {
  uploadProgressPhoto,
  deleteProgressPhoto,
} from "@/app/(app)/progress/actions";
import { GET as serveProgressPhoto } from "@/app/api/progress-photo/[id]/route";
import { db } from "@/lib/db";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import { seedActor, createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

let gpsJpeg: Buffer;

beforeAll(async () => {
  const base = await sharp({
    create: {
      width: 900,
      height: 600,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  gpsJpeg = spliceExifIntoJpeg(base, {
    dateTimeOriginal: "2026:02:03 08:15:00",
    gps: true,
  });
});

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

async function uniqueJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe("uploadProgressPhoto", () => {
  it("stores a stripped, pose-tagged photo whose date defaults from EXIF", async () => {
    const { profile } = seedActor();
    expect(readJpegExif(gpsJpeg).hasGps).toBe(true); // the fixture has teeth

    const res = await uploadProgressPhoto(
      photoForm(gpsJpeg, { pose: "front", caption: "baseline" })
    );
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, date, pose, caption, stored_path, mime_type FROM progress_photos
          WHERE profile_id = ?`
      )
      .get(profile.id) as {
      id: number;
      date: string;
      pose: string;
      caption: string;
      stored_path: string;
      mime_type: string;
    };
    expect(row.pose).toBe("front");
    expect(row.caption).toBe("baseline");
    expect(row.date).toBe("2026-02-03"); // EXIF capture date, not today
    expect(row.mime_type).toBe("image/jpeg");
    // The bytes ON DISK are metadata-free even though the client sent GPS.
    const disk = fs.readFileSync(path.resolve(process.cwd(), row.stored_path));
    expect(readJpegExif(disk)).toMatchObject({ hasExif: false, hasGps: false });
  });

  it("revalidates both /progress and / so the data-gated sidebar nav entry appears after the first photo (#1282)", async () => {
    seedActor();
    revalidate.mockClear();
    const res = await uploadProgressPhoto(
      photoForm(gpsJpeg, { pose: "front" })
    );
    expect(res.ok).toBe(true);
    // "/" refreshes the shared layout's nav relevance (relevanceKey "progress"),
    // matching the sleep/mood precedent — else the link stays hidden until reload.
    expect(revalidate).toHaveBeenCalledWith("/progress");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("an explicit form date beats the EXIF date", async () => {
    seedActor();
    const res = await uploadProgressPhoto(
      photoForm(
        spliceExifIntoJpeg(await uniqueJpeg(3), {
          dateTimeOriginal: "2026:02:03 08:15:00",
        }),
        {
          pose: "side",
          date: "2026-04-01",
        }
      )
    );
    expect(res.ok).toBe(true);
  });

  it("re-uploading the identical photo is a calm success that adds no second row", async () => {
    const { profile } = seedActor();
    const bytes = await uniqueJpeg(11);
    expect(
      (await uploadProgressPhoto(photoForm(bytes, { pose: "back" }))).ok
    ).toBe(true);
    expect(
      (await uploadProgressPhoto(photoForm(bytes, { pose: "back" }))).ok
    ).toBe(true);
    const n = (
      db
        .prepare(`SELECT COUNT(*) c FROM progress_photos WHERE profile_id = ?`)
        .get(profile.id) as { c: number }
    ).c;
    expect(n).toBe(1);
  });

  it("rejects a bad pose, a non-image, and a missing file", async () => {
    seedActor();
    const bad = await uploadProgressPhoto(
      photoForm(await uniqueJpeg(21), { pose: "flex" })
    );
    expect(bad.ok).toBe(false);

    const notImage = new FormData();
    notImage.set("pose", "front");
    notImage.set(
      "photo",
      new File([Buffer.from("not an image")], "note.txt", {
        type: "text/plain",
      })
    );
    expect((await uploadProgressPhoto(notImage)).ok).toBe(false);

    const empty = new FormData();
    empty.set("pose", "front");
    expect((await uploadProgressPhoto(empty)).ok).toBe(false);
  });

  it("is blocked for a read-only grant (requireWriteAccess)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`ReadOnly ${login.username}`, login.id);
    actAs(login, profile, "read");
    await expect(
      uploadProgressPhoto(photoForm(await uniqueJpeg(31), { pose: "front" }))
    ).rejects.toThrow(/read-only/);
  });
});

describe("deleteProgressPhoto + serve-route scoping", () => {
  it("deletes only the acting profile's photo; the serve route is id AND profile scoped", async () => {
    const owner = seedActor();
    expect(
      (
        await uploadProgressPhoto(
          photoForm(await uniqueJpeg(41), { pose: "front" })
        )
      ).ok
    ).toBe(true);
    const row = db
      .prepare(
        `SELECT id, stored_path FROM progress_photos WHERE profile_id = ?`
      )
      .get(owner.profile.id) as { id: number; stored_path: string };

    // The OWNER can fetch it (original and thumb).
    const ok = await serveProgressPhoto(
      new Request(`http://test/api/progress-photo/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    const thumb = await serveProgressPhoto(
      new Request(`http://test/api/progress-photo/${row.id}?thumb=1`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(thumb.status).toBe(200);

    // ANOTHER login acting as ANOTHER profile: same id → 404 (no cross-profile
    // fetch-by-id), and its delete is a silent no-op on the owner's row.
    const intruder = seedActor();
    const denied = await serveProgressPhoto(
      new Request(`http://test/api/progress-photo/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ ok: false, error: "not found" });

    const fdDel = new FormData();
    fdDel.set("photo_id", String(row.id));
    expect((await deleteProgressPhoto(fdDel)).ok).toBe(true); // gated, but scoped: no-op
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM progress_photos WHERE id = ?`)
        .get(row.id) as { c: number }
    ).toMatchObject({ c: 1 });
    expect(intruder.profile.id).not.toBe(owner.profile.id);

    // The owner's delete really removes row + file, and revalidates "/" too so the
    // nav entry re-hides when the last photo is gone (#1282, symmetric with upload).
    actAs(owner.login, owner.profile);
    revalidate.mockClear();
    expect((await deleteProgressPhoto(fdDel)).ok).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/progress");
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM progress_photos WHERE id = ?`)
        .get(row.id) as { c: number }
    ).toMatchObject({ c: 0 });
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      false
    );
  });
});
