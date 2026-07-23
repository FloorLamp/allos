// DB INTEGRATION TIER — the physique progress-photo domain over the shared photo
// core (#1119 phases 1+2). Drives the REAL pipeline end to end: sharp-generated
// JPEGs with synthetic EXIF spliced in (lib/photo/exif-fixture.ts — no real
// photograph exists in the repo) → processPhoto (harvest → auto-orient → STRIP →
// downscale → thumbnail) → addProgressPhotoCore (dedup, weight snapshot, file
// store) against the real temp-DB schema (migration 096 replayed by setup).
//
// The privacy pins live here because the pure tier structurally can't see them:
// the STORED FILE on disk must carry no Exif/GPS segment, and the harvested
// capture date must have been read before the strip.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { processPhoto, type ProcessedPhoto } from "@/lib/photo/ingest";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import {
  fitWithin,
  PHOTO_MAX_EDGE,
  PHOTO_THUMB_EDGE,
} from "@/lib/photo/policy";
import { photoDomainRoot } from "@/lib/photo/store";
import {
  addProgressPhotoCore,
  deleteProgressPhotoCore,
  getProgressPhotos,
  weightSnapshotForDate,
} from "@/lib/progress-photo-write";

let profileId: number;

// A real decodable JPEG of the given size/color (sharp-generated — synthetic).
async function makeJpeg(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function processed(
  width = 640,
  height = 480,
  rgb = { r: 180, g: 60, b: 60 }
): Promise<ProcessedPhoto> {
  const out = await processPhoto(await makeJpeg(width, height, rgb));
  if (out.kind !== "processed") throw new Error(`unexpected: ${out.kind}`);
  return out.photo;
}

beforeAll(() => {
  profileId = Number(
    db.prepare(`INSERT INTO profiles (name) VALUES ('Photo Fixture')`).run()
      .lastInsertRowid
  );
});

afterAll(() => {
  // The store writes real files under the repo's data/uploads (gitignored);
  // clean this fixture profile's dir so repeated local runs don't accumulate.
  fs.rmSync(path.join(photoDomainRoot("progress"), String(profileId)), {
    recursive: true,
    force: true,
  });
});

describe("processPhoto — the ingest pipeline", () => {
  it("strips EXIF/GPS, harvests the capture date first, and downscales", async () => {
    const raw = spliceExifIntoJpeg(
      await makeJpeg(3000, 2000, { r: 9, g: 99, b: 9 }),
      {
        dateTimeOriginal: "2026:03:14 09:26:53",
        gps: true,
      }
    );
    // The input really carries GPS (the fixture has teeth).
    expect(readJpegExif(raw).hasGps).toBe(true);

    const out = await processPhoto(raw);
    expect(out.kind).toBe("processed");
    if (out.kind !== "processed") return;
    const p = out.photo;

    // Harvested BEFORE the strip…
    expect(p.captureDate).toBe("2026-03-14");
    // …and the OUTPUT bytes carry no metadata block at all (GPS included).
    expect(readJpegExif(p.bytes)).toMatchObject({
      hasExif: false,
      hasGps: false,
    });
    expect(readJpegExif(p.thumbBytes)).toMatchObject({
      hasExif: false,
      hasGps: false,
    });

    // Downscale matches the ONE pure sizing computation.
    const expected = fitWithin(3000, 2000, PHOTO_MAX_EDGE);
    expect({ width: p.width, height: p.height }).toEqual({
      width: expected.width,
      height: expected.height,
    });
    const thumbMeta = await sharp(p.thumbBytes).metadata();
    const expectedThumb = fitWithin(p.width, p.height, PHOTO_THUMB_EDGE);
    expect(thumbMeta.width).toBe(expectedThumb.width);
    expect(thumbMeta.height).toBe(expectedThumb.height);
    expect(p.mime).toBe("image/jpeg");
  });

  it("bakes the EXIF orientation into pixels (auto-orient)", async () => {
    // Orientation 6 = rotate 90° CW: a landscape 640×480 renders portrait.
    const raw = spliceExifIntoJpeg(
      await makeJpeg(640, 480, { r: 1, g: 2, b: 3 }),
      {
        orientation: 6,
      }
    );
    const out = await processPhoto(raw);
    expect(out.kind).toBe("processed");
    if (out.kind !== "processed") return;
    expect(out.photo.width).toBe(480);
    expect(out.photo.height).toBe(640);
    // And the orientation tag itself is gone with the rest of the metadata.
    expect(readJpegExif(out.photo.bytes).orientation).toBeNull();
  });

  it("keeps small images at native size (no enlargement) and stays clean without EXIF", async () => {
    const out = await processPhoto(
      await makeJpeg(320, 240, { r: 5, g: 5, b: 5 })
    );
    expect(out.kind).toBe("processed");
    if (out.kind !== "processed") return;
    expect(out.photo.width).toBe(320);
    expect(out.photo.height).toBe(240);
    expect(out.photo.captureDate).toBeNull();
  });

  it("rejects non-images, empties, and undecodable bytes with typed outcomes", async () => {
    expect(await processPhoto(Buffer.alloc(0))).toMatchObject({
      kind: "invalid",
    });
    expect(
      await processPhoto(Buffer.from("not an image at all"))
    ).toMatchObject({
      kind: "invalid",
    });
    // JPEG magic bytes but garbage body: sniffs as image, fails decode.
    const fake = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from("garbage-not-a-real-jpeg-body"),
    ]);
    expect(await processPhoto(fake)).toMatchObject({ kind: "invalid" });
  });
});

describe("addProgressPhotoCore / getProgressPhotos / delete", () => {
  it("stores per pose, snapshots the nearby weight, and files land per-profile", async () => {
    const date = today(profileId);
    // A weigh-in 2 days before the photo, inside the 7-day window.
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
    ).run(profileId, shiftDateStr(date, -2), 82.1);

    const photo = await processed(800, 600, { r: 10, g: 20, b: 30 });
    const outcome = addProgressPhotoCore(
      profileId,
      { date, pose: "front", caption: "  week 1  " },
      photo
    );
    expect(outcome.kind).toBe("added");
    if (outcome.kind !== "added") return;

    const rows = getProgressPhotos(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0].pose).toBe("front");
    expect(rows[0].caption).toBe("week 1");
    expect(rows[0].weight_kg_snapshot).toBe(82.1);

    const stored = db
      .prepare(
        `SELECT stored_path, thumb_path FROM progress_photos WHERE id = ? AND profile_id = ?`
      )
      .get(outcome.id, profileId) as {
      stored_path: string;
      thumb_path: string;
    };
    expect(stored.stored_path).toContain(
      `progress-photos${path.sep}${profileId}${path.sep}`
    );
    // Both files exist on disk and the STORED file is metadata-free.
    const abs = path.resolve(process.cwd(), stored.stored_path);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), stored.thumb_path))).toBe(
      true
    );
    expect(readJpegExif(fs.readFileSync(abs))).toMatchObject({
      hasExif: false,
      hasGps: false,
    });
  });

  it("carries no snapshot when the nearest weigh-in is outside the 7-day window", () => {
    const date = today(profileId);
    expect(
      weightSnapshotForDate(profileId, shiftDateStr(date, -60))
    ).toBeNull();
  });

  it("dedups per-profile on the processed content hash", async () => {
    const photo = await processed(500, 500, { r: 77, g: 77, b: 77 });
    const first = addProgressPhotoCore(
      profileId,
      { date: today(profileId), pose: "side", caption: null },
      photo
    );
    expect(first.kind).toBe("added");
    const again = addProgressPhotoCore(
      profileId,
      { date: today(profileId), pose: "side", caption: null },
      photo
    );
    expect(again.kind).toBe("duplicate");
    if (first.kind === "added" && again.kind === "duplicate")
      expect(again.id).toBe(first.id);

    // A DIFFERENT profile may hold the same content (dedup is per-profile).
    const otherProfile = Number(
      db.prepare(`INSERT INTO profiles (name) VALUES ('Photo Fixture B')`).run()
        .lastInsertRowid
    );
    const other = addProgressPhotoCore(
      otherProfile,
      { date: today(otherProfile), pose: "side", caption: null },
      photo
    );
    expect(other.kind).toBe("added");
    fs.rmSync(path.join(photoDomainRoot("progress"), String(otherProfile)), {
      recursive: true,
      force: true,
    });
  });

  it("rejects an off-vocabulary pose and a bad date", async () => {
    const photo = await processed(400, 300, { r: 1, g: 1, b: 1 });
    expect(
      addProgressPhotoCore(
        profileId,
        { date: today(profileId), pose: "flex", caption: null },
        photo
      )
    ).toMatchObject({ kind: "invalid" });
    expect(
      addProgressPhotoCore(
        profileId,
        { date: "2026-13-40", pose: "front", caption: null },
        photo
      )
    ).toMatchObject({ kind: "invalid" });
  });

  it("delete removes the row AND both files, path-contained, idempotent", async () => {
    const photo = await processed(600, 400, { r: 200, g: 100, b: 50 });
    const outcome = addProgressPhotoCore(
      profileId,
      { date: today(profileId), pose: "back", caption: null },
      photo
    );
    expect(outcome.kind).toBe("added");
    if (outcome.kind !== "added") return;
    const stored = db
      .prepare(
        `SELECT stored_path, thumb_path FROM progress_photos WHERE id = ? AND profile_id = ?`
      )
      .get(outcome.id, profileId) as {
      stored_path: string;
      thumb_path: string;
    };

    // A FORGED cross-profile delete is a no-op…
    expect(deleteProgressPhotoCore(profileId + 9999, outcome.id)).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), stored.stored_path))).toBe(
      true
    );

    // …the owner's delete removes row + files, and repeats are safe.
    expect(deleteProgressPhotoCore(profileId, outcome.id)).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), stored.stored_path))).toBe(
      false
    );
    expect(fs.existsSync(path.resolve(process.cwd(), stored.thumb_path))).toBe(
      false
    );
    expect(deleteProgressPhotoCore(profileId, outcome.id)).toBe(false);
  });
});
