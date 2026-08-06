// DB INTEGRATION TIER — the one-time lesion/symptom photo metadata backfill (#1844).
//
// Builds a corpus that looks like a pre-photo-core instance: legacy filenames, mixed
// containers, and files that still carry the synthetic GPS EXIF fixture. Then proves
// the properties the owner's strip-in-place ruling depends on:
//
//   • every stored file comes out metadata-free, in place, under its own name;
//   • the row's byte-derived facts (mime/size/content_hash) follow the new bytes;
//   • a file that is ALREADY clean is skipped, not re-compressed — which is what
//     makes the pass safe to re-run (idempotence is per FILE, not just per marker);
//   • a file that cannot be cleaned is counted `failed` and left EXACTLY as it was;
//   • the marker claim is taken once, so two boots can't both sweep.
//
// Deterministic: real (tiny) images built by sharp, a temp DB from setup.ts, and the
// per-profile upload dirs this suite writes are removed in afterAll.

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { db } from "@/lib/db";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import { processPhoto } from "@/lib/photo/ingest";
import { photoDomainRoot, thumbSiblingPath } from "@/lib/photo/store";
import {
  backfillPhotoMetadata,
  isPhotoBackfillDue,
  photoBackfillDue,
  runPhotoMetadataBackfill,
  PHOTO_BACKFILL_MARKER,
  PHOTO_BACKFILL_VERSION,
} from "@/lib/photo/metadata-backfill";

const createdProfiles: number[] = [];

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  createdProfiles.push(id);
  return id;
}

afterAll(() => {
  for (const id of createdProfiles) {
    for (const domain of ["lesion", "symptom"] as const) {
      fs.rmSync(path.join(photoDomainRoot(domain), String(id)), {
        recursive: true,
        force: true,
      });
    }
  }
});

async function jpegBytes(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: (seed * 41) % 255, g: 120, b: (seed * 17) % 255 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function pngBytes(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 240,
      height: 180,
      channels: 3,
      background: { r: 30, g: (seed * 23) % 255, b: (seed * 53) % 255 },
    },
  })
    .png()
    .toBuffer();
}

// Write a file the pre-core way: <hash16>-<name> under the domain's per-profile dir,
// with the row carrying the hash of the ORIGINAL bytes.
function seedLegacyFile(
  domain: "lesion" | "symptom",
  profileId: number,
  name: string,
  bytes: Buffer
): { storedPath: string; hash: string } {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(photoDomainRoot(domain), String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${hash.slice(0, 16)}-${name}`;
  fs.writeFileSync(path.join(dir, fileName), bytes);
  return {
    storedPath: path.join(
      "data",
      "uploads",
      `${domain}-photos`,
      String(profileId),
      fileName
    ),
    hash,
  };
}

function insertLesionPhoto(
  profileId: number,
  lesionId: number,
  stored: { storedPath: string; hash: string },
  mime: string,
  size: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO lesion_photos
           (profile_id, lesion_id, date, stored_path, content_hash, mime_type, size_bytes)
         VALUES (?, ?, '2026-03-01', ?, ?, ?, ?)`
      )
      .run(profileId, lesionId, stored.storedPath, stored.hash, mime, size)
      .lastInsertRowid
  );
}

function insertSymptomPhoto(
  profileId: number,
  stored: { storedPath: string; hash: string },
  mime: string,
  size: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO symptom_photos
           (profile_id, date, stored_path, content_hash, mime_type, size_bytes)
         VALUES (?, '2026-03-02', ?, ?, ?, ?)`
      )
      .run(profileId, stored.storedPath, stored.hash, mime, size)
      .lastInsertRowid
  );
}

function newLesion(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO skin_lesions (profile_id, label, status) VALUES (?, 'Mole', 'active')`
      )
      .run(profileId).lastInsertRowid
  );
}

function abs(rel: string): string {
  return path.resolve(process.cwd(), rel);
}

describe("backfillPhotoMetadata — strip in place", () => {
  it("cleans stored lesion/symptom photos, then skips them on a re-run", async () => {
    const profileId = newProfile("Backfill Subject");
    const lesionId = newLesion(profileId);

    // 1. A lesion photo with GPS EXIF — the exposure this pass exists for.
    const tagged = spliceExifIntoJpeg(await jpegBytes(1), {
      dateTimeOriginal: "2026:02:14 09:00:00",
      gps: true,
    });
    const taggedFile = seedLegacyFile("lesion", profileId, "mole.jpg", tagged);
    const taggedId = insertLesionPhoto(
      profileId,
      lesionId,
      taggedFile,
      "image/jpeg",
      tagged.length
    );

    // 2. A symptom photo stored as PNG — no EXIF parser covers that container, so it
    //    is re-encoded rather than trusted.
    const png = await pngBytes(2);
    const pngFile = seedLegacyFile("symptom", profileId, "rash.png", png);
    const pngId = insertSymptomPhoto(
      profileId,
      pngFile,
      "image/png",
      png.length
    );

    // 3. A photo that is already exactly what the pipeline produces.
    const processed = await processPhoto(await jpegBytes(3));
    if (processed.kind !== "processed")
      throw new Error("fixture not processed");
    const cleanFile = seedLegacyFile(
      "symptom",
      profileId,
      "clean.jpg",
      processed.photo.bytes
    );
    const cleanId = insertSymptomPhoto(
      profileId,
      cleanFile,
      "image/jpeg",
      processed.photo.bytes.length
    );

    // 4. A row whose file is gone (a restore that missed the uploads dir).
    const missing = seedLegacyFile(
      "lesion",
      profileId,
      "gone.jpg",
      await jpegBytes(4)
    );
    insertLesionPhoto(profileId, lesionId, missing, "image/jpeg", 10);
    fs.rmSync(abs(missing.storedPath));

    // 5. A file that is not a decodable image at all.
    const corrupt = seedLegacyFile(
      "symptom",
      profileId,
      "corrupt.jpg",
      Buffer.from("this is not an image")
    );
    insertSymptomPhoto(profileId, corrupt, "image/jpeg", 20);

    expect(
      readJpegExif(fs.readFileSync(abs(taggedFile.storedPath))).hasGps
    ).toBe(true); // the fixture has teeth

    const first = await backfillPhotoMetadata(db);
    expect(first).toEqual({ processed: 2, skipped: 2, failed: 1 });

    // The GPS photo is clean, at its ORIGINAL path, with a thumbnail beside it.
    const cleaned = fs.readFileSync(abs(taggedFile.storedPath));
    expect(readJpegExif(cleaned).hasExif).toBe(false);
    expect(readJpegExif(cleaned).hasGps).toBe(false);
    expect(fs.existsSync(abs(thumbSiblingPath(taggedFile.storedPath)))).toBe(
      true
    );

    // The row's byte-derived facts followed the bytes; nothing else did.
    const row = db
      .prepare(
        `SELECT date, mime_type, size_bytes, content_hash, stored_path
           FROM lesion_photos WHERE id = ?`
      )
      .get(taggedId) as {
      date: string;
      mime_type: string;
      size_bytes: number;
      content_hash: string;
      stored_path: string;
    };
    expect(row.date).toBe("2026-03-01");
    expect(row.stored_path).toBe(taggedFile.storedPath);
    expect(row.mime_type).toBe("image/jpeg");
    expect(row.size_bytes).toBe(cleaned.length);
    expect(row.content_hash).toBe(
      crypto.createHash("sha256").update(cleaned).digest("hex")
    );
    // …and it is NOT the hash of the bytes that used to be there.
    expect(row.content_hash).not.toBe(taggedFile.hash);

    // The PNG became the pipeline's JPEG; its row says so, so the serve route can't
    // hand a browser a Content-Type its bytes contradict.
    const pngRow = db
      .prepare(`SELECT mime_type FROM symptom_photos WHERE id = ?`)
      .get(pngId) as { mime_type: string };
    expect(pngRow.mime_type).toBe("image/jpeg");
    expect(readJpegExif(fs.readFileSync(abs(pngFile.storedPath))).hasExif).toBe(
      false
    );

    // The already-clean file was left byte-for-byte alone.
    expect(fs.readFileSync(abs(cleanFile.storedPath))).toEqual(
      processed.photo.bytes
    );
    expect(
      db
        .prepare(`SELECT content_hash FROM symptom_photos WHERE id = ?`)
        .get(cleanId)
    ).toEqual({ content_hash: cleanFile.hash });

    // The undecodable file is untouched — a failure never replaces bytes.
    expect(fs.readFileSync(abs(corrupt.storedPath)).toString()).toBe(
      "this is not an image"
    );

    // RE-RUN: nothing left to process, and the cleaned bytes are not re-compressed.
    const second = await backfillPhotoMetadata(db);
    expect(second).toEqual({ processed: 0, skipped: 4, failed: 1 });
    expect(fs.readFileSync(abs(taggedFile.storedPath))).toEqual(cleaned);
  });

  it("keeps a row's historical hash when two photos converge on one", async () => {
    const profileId = newProfile("Backfill Converge");
    const lesionId = newLesion(profileId);
    // The same photograph saved twice with different metadata: distinct originals,
    // identical pixels. After the strip both would hash the same, and the partial
    // unique index on (profile_id, content_hash) would refuse the second.
    const base = await jpegBytes(9);
    const a = spliceExifIntoJpeg(base, {
      dateTimeOriginal: "2026:04:01 08:00:00",
    });
    const b = spliceExifIntoJpeg(base, {
      dateTimeOriginal: "2026:04:02 08:00:00",
    });
    const fileA = seedLegacyFile("lesion", profileId, "a.jpg", a);
    const fileB = seedLegacyFile("lesion", profileId, "b.jpg", b);
    const idA = insertLesionPhoto(
      profileId,
      lesionId,
      fileA,
      "image/jpeg",
      a.length
    );
    const idB = insertLesionPhoto(
      profileId,
      lesionId,
      fileB,
      "image/jpeg",
      b.length
    );

    // The sweep is instance-wide, so its tally also counts the corpus above; what
    // this case is about is the two rows below.
    await backfillPhotoMetadata(db);
    // Both files are clean — the privacy outcome never depends on the hash bookkeeping.
    for (const f of [fileA, fileB]) {
      expect(readJpegExif(fs.readFileSync(abs(f.storedPath))).hasExif).toBe(
        false
      );
    }
    const hashes = db
      .prepare(
        `SELECT id, content_hash FROM lesion_photos WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as { id: number; content_hash: string }[];
    expect(hashes.map((h) => h.id)).toEqual([idA, idB]);
    expect(hashes[0].content_hash).not.toBe(hashes[1].content_hash);
    // The loser kept the hash it arrived with rather than colliding.
    expect(hashes[1].content_hash).toBe(fileB.hash);
  });

  it("leaves the original bytes intact when a replace fails, so the retry works", async () => {
    // The stored file is this pass's own resume marker: once it holds clean bytes,
    // `alreadyClean` skips the row forever. So a half-done photo must never be the
    // half where the STORED file was replaced — the thumbnail goes first, and this
    // pins that. Fail the stored file's rename (the thumb's has already succeeded)
    // and the photo must come out untouched, not silently stranded with byte-derived
    // columns describing bytes that are no longer there.
    const profileId = newProfile("Backfill Retry");
    const lesionId = newLesion(profileId);
    const tagged = spliceExifIntoJpeg(await jpegBytes(11), {
      dateTimeOriginal: "2026:05:05 12:00:00",
      gps: true,
    });
    const file = seedLegacyFile("lesion", profileId, "retry.jpg", tagged);
    const id = insertLesionPhoto(
      profileId,
      lesionId,
      file,
      "image/jpeg",
      tagged.length
    );

    const target = abs(file.storedPath);
    const thumbTarget = abs(thumbSiblingPath(file.storedPath));
    const realRename = fs.renameSync;
    // Fail the THUMBNAIL write specifically. That is the case the ordering exists
    // for: with the stored file written first, this failure would land AFTER the
    // photo had already been replaced — clean bytes, an un-updated row, and an
    // `alreadyClean` skip on every later pass.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === thumbTarget) throw new Error("disk full");
      return realRename(from, to);
    });
    try {
      await backfillPhotoMetadata(db);
    } finally {
      spy.mockRestore();
    }

    // Untouched: still the bytes it arrived with, GPS and all, and the row still
    // describes them — so nothing downstream is lying about this photo.
    expect(fs.readFileSync(target)).toEqual(tagged);
    expect(readJpegExif(fs.readFileSync(target)).hasGps).toBe(true);
    expect(
      db.prepare(`SELECT content_hash FROM lesion_photos WHERE id = ?`).get(id)
    ).toEqual({ content_hash: file.hash });

    // And the very next pass cleans it, because `alreadyClean` still says no.
    await backfillPhotoMetadata(db);
    const cleaned = fs.readFileSync(target);
    expect(readJpegExif(cleaned).hasGps).toBe(false);
    expect(
      db
        .prepare(
          `SELECT content_hash, mime_type FROM lesion_photos WHERE id = ?`
        )
        .get(id)
    ).toEqual({
      content_hash: crypto.createHash("sha256").update(cleaned).digest("hex"),
      mime_type: "image/jpeg",
    });
  });
});

describe("the once-per-install marker", () => {
  it("treats a done marker as settled, an old version and a stale claim as due", () => {
    const claimedAt = "2026-08-01T00:00:00.000Z";
    const now = Date.parse("2026-08-01T00:10:00.000Z");
    expect(photoBackfillDue(null, now)).toBe(true);
    expect(
      photoBackfillDue(
        { version: PHOTO_BACKFILL_VERSION, state: "done", claimedAt },
        now
      )
    ).toBe(false);
    // A marker left by an older version of the pass does not settle the current one.
    expect(
      photoBackfillDue({ version: 0, state: "done", claimedAt }, now)
    ).toBe(true);
    // A live claim is respected; one older than the stale window is picked back up.
    expect(
      photoBackfillDue(
        { version: PHOTO_BACKFILL_VERSION, state: "running", claimedAt },
        now
      )
    ).toBe(false);
    expect(
      photoBackfillDue(
        { version: PHOTO_BACKFILL_VERSION, state: "running", claimedAt },
        Date.parse("2026-08-01T02:00:00.000Z")
      )
    ).toBe(true);
  });

  it("claims the sweep exactly once", () => {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(PHOTO_BACKFILL_MARKER);
    expect(isPhotoBackfillDue(db)).toBe(true);

    runPhotoMetadataBackfill(db);
    // The claim is written synchronously, before the detached sweep runs, so a
    // second process booting a moment later finds the work taken.
    const claim = JSON.parse(
      (
        db
          .prepare(`SELECT value FROM settings WHERE key = ?`)
          .get(PHOTO_BACKFILL_MARKER) as { value: string }
      ).value
    );
    expect(claim.version).toBe(PHOTO_BACKFILL_VERSION);
    expect(isPhotoBackfillDue(db)).toBe(false);

    runPhotoMetadataBackfill(db);
    const after = JSON.parse(
      (
        db
          .prepare(`SELECT value FROM settings WHERE key = ?`)
          .get(PHOTO_BACKFILL_MARKER) as { value: string }
      ).value
    );
    expect(after.claimedAt).toBe(claim.claimedAt);
  });
});
