// SERVER-ACTION TIER — skin-lesion write path (#715). Exercises add / update / delete /
// track-follow-up + photo attach/delete against a real (temp) SQLite handle to prove
// every mutation is profile-scoped, that status / body_region / body_side are normalized
// onto the DB CHECK sets (an off-vocabulary form can never trip the constraint), that a
// manual row carries NULL provenance, that the skin follow-up chain (create + delete
// unlink) works, and that deleting a lesion clears its photos first (no FK trip). The
// static source scan can't see across the action boundary; this is the dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import { thumbSiblingPath } from "@/lib/photo/store";
import { revalidatePath } from "next/cache";
import {
  addSkinLesion,
  updateSkinLesion,
  deleteSkinLesion,
  trackSkinFollowUp,
  uploadLesionPhoto,
  deleteLesionPhoto,
} from "@/app/(app)/records/specialty/skin/actions";
import { db } from "@/lib/db";
import { getSkinLesions, getSkinLesionFollowUps } from "@/lib/queries";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// Real image bytes: since #1844 the upload runs through the shared photo core, which
// decodes and re-encodes the file, so a truncated-signature stub is no longer a
// stand-in for a photo. Each call paints a distinct colour so the per-profile
// content-hash dedup sees distinct captures.
let seed = 0;
async function photoFile(name = "mole.png"): Promise<File> {
  seed += 1;
  const bytes = await sharp({
    create: {
      width: 120,
      height: 90,
      channels: 3,
      background: { r: (seed * 31) % 255, g: (seed * 57) % 255, b: 90 },
    },
  })
    .png()
    .toBuffer();
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

describe("addSkinLesion", () => {
  it("stores a profile-scoped lesion and normalizes the enum fields", async () => {
    const { profile } = seedActor();
    const res = await addSkinLesion(
      fd({
        label: "Upper left forearm mole",
        body_region: "Forearm", // → forearm
        body_side: "LEFT", // → left
        status: "watch",
        size_mm: "6.25", // → 6.3
        asymmetry: "1",
        evolving: "on",
        observed_date: "2026-02-01",
        finding: "slightly raised, dark brown",
        follow_up_interval_days: "90",
      })
    );
    expect(res.ok).toBe(true);

    const rows = getSkinLesions(profile.id);
    expect(rows).toHaveLength(1);
    const l = rows[0];
    expect(l.label).toBe("Upper left forearm mole");
    expect(l.body_region).toBe("forearm");
    expect(l.body_side).toBe("left");
    expect(l.status).toBe("watch");
    expect(l.size_mm).toBe(6.3);
    expect(l.asymmetry).toBe(1);
    expect(l.evolving).toBe(1);
    expect(l.border).toBe(0);
    expect(l.follow_up_interval_days).toBe(90);
    // Manual rows carry no import provenance.
    expect(l.source).toBeNull();
    expect(l.document_id).toBeNull();
    expect(l.external_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/records");
  });

  it("rejects a lesion with neither a label nor a region", async () => {
    seedActor();
    const res = await addSkinLesion(fd({ label: "  ", body_region: "" }));
    expect(res.ok).toBe(false);
  });

  it("degrades an off-vocabulary status to the safe default", async () => {
    const { profile } = seedActor();
    await addSkinLesion(fd({ label: "Spot", status: "suspicious" }));
    expect(getSkinLesions(profile.id)[0].status).toBe("active");
  });
});

describe("updateSkinLesion is profile-scoped", () => {
  it("won't edit another profile's lesion", async () => {
    seedActor();
    const other = createProfile("other-subject");
    const otherId = Number(
      db
        .prepare(
          `INSERT INTO skin_lesions (profile_id, label, status) VALUES (?, 'X', 'active')`
        )
        .run(other.id).lastInsertRowid
    );
    const res = await updateSkinLesion(
      fd({ id: String(otherId), label: "Hacked" })
    );
    expect(res.ok).toBe(true); // no row matched the WHERE id AND profile_id
    const row = db
      .prepare("SELECT label FROM skin_lesions WHERE id = ?")
      .get(otherId) as { label: string };
    expect(row.label).toBe("X");
  });
});

describe("trackSkinFollowUp + deleteSkinLesion (the #700 chain)", () => {
  it("creates a linked follow-up and de-links it on delete (never cascade-drops)", async () => {
    const { profile } = seedActor();
    await addSkinLesion(
      fd({
        label: "Left forearm mole",
        body_region: "forearm",
        body_side: "left",
        status: "watch",
        observed_date: "2026-03-01",
      })
    );
    const recId = getSkinLesions(profile.id)[0].id;

    const tracked = await trackSkinFollowUp(
      fd({ record_id: String(recId), interval_days: "91" })
    );
    expect(tracked.ok).toBe(true);

    const followUps = getSkinLesionFollowUps(profile.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].sourceSkinLesionId).toBe(recId);
    const cpId = followUps[0].carePlanItemId;

    // Idempotent — a second track returns the same open follow-up (no duplicate).
    await trackSkinFollowUp(
      fd({ record_id: String(recId), interval_days: "91" })
    );
    expect(getSkinLesionFollowUps(profile.id)).toHaveLength(1);

    // Delete the source lesion: the follow-up survives, de-linked (source cleared).
    await deleteSkinLesion(fd({ id: String(recId) }));
    expect(getSkinLesions(profile.id)).toHaveLength(0);
    const cp = db
      .prepare(
        "SELECT source_kind, source_skin_lesion_id FROM care_plan_items WHERE id = ?"
      )
      .get(cpId) as {
      source_kind: string | null;
      source_skin_lesion_id: number | null;
    };
    expect(cp.source_kind).toBeNull();
    expect(cp.source_skin_lesion_id).toBeNull();
  });
});

describe("lesion photos (attach / delete, and delete-lesion clears them first)", () => {
  it("attaches a dated photo to a lesion and removes it (row + file)", async () => {
    const { profile } = seedActor();
    await addSkinLesion(fd({ label: "Back spot", body_region: "back" }));
    const lesionId = getSkinLesions(profile.id)[0].id;

    const form = new FormData();
    form.set("lesion_id", String(lesionId));
    form.set("date", "2026-04-01");
    form.set("caption", "baseline");
    form.set("photo", await photoFile());
    const res = await uploadLesionPhoto(form);
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, lesion_id, mime_type FROM lesion_photos WHERE profile_id = ?`
      )
      .get(profile.id) as
      { id: number; lesion_id: number; mime_type: string } | undefined;
    expect(row?.lesion_id).toBe(lesionId);
    // The core re-encodes every accepted photo to JPEG on the way in — the stored
    // mime is the PIPELINE's, never the uploaded container's.
    expect(row?.mime_type).toBe("image/jpeg");

    const del = await deleteLesionPhoto(fd({ photo_id: String(row!.id) }));
    expect(del.ok).toBe(true);
    expect(
      db.prepare(`SELECT 1 FROM lesion_photos WHERE id = ?`).get(row!.id)
    ).toBeUndefined();
  });

  it("deleting a lesion clears its photos first (no FK trip)", async () => {
    const { profile } = seedActor();
    await addSkinLesion(
      fd({ label: "Shoulder mole", body_region: "shoulder" })
    );
    const lesionId = getSkinLesions(profile.id)[0].id;
    const form = new FormData();
    form.set("lesion_id", String(lesionId));
    form.set("date", "2026-04-01");
    form.set("photo", await photoFile("shoulder.png"));
    expect((await uploadLesionPhoto(form)).ok).toBe(true);

    const del = await deleteSkinLesion(fd({ id: String(lesionId) }));
    expect(del.ok).toBe(true);
    expect(getSkinLesions(profile.id)).toHaveLength(0);
    expect(
      db
        .prepare(`SELECT 1 FROM lesion_photos WHERE lesion_id = ?`)
        .get(lesionId)
    ).toBeUndefined();
  });

  // The load-bearing #1844 pin: dermatology close-ups were the most sensitive photos
  // in the app and, until phase 3, the ONLY thing between their GPS coordinates and
  // disk was that nobody looked. The action never trusts the client's bytes.
  it("stores a metadata-free file even when the upload carries GPS EXIF", async () => {
    const { profile } = seedActor();
    await addSkinLesion(fd({ label: "Calf mole", body_region: "calf" }));
    const lesionId = getSkinLesions(profile.id)[0].id;
    const base = await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 3,
        background: { r: 12, g: 200, b: 60 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const tagged = spliceExifIntoJpeg(base, {
      dateTimeOriginal: "2026:03:09 07:30:00",
      gps: true,
    });
    expect(readJpegExif(tagged).hasGps).toBe(true); // the fixture has teeth

    const form = new FormData();
    form.set("lesion_id", String(lesionId));
    form.set(
      "photo",
      new File([new Uint8Array(tagged)], "mole.jpg", { type: "image/jpeg" })
    );
    expect((await uploadLesionPhoto(form)).ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, date, stored_path FROM lesion_photos WHERE profile_id = ?`
      )
      .get(profile.id) as { id: number; date: string; stored_path: string };
    // The DATE came out of the EXIF that was harvested before the strip: the form
    // carried no date, and the capture day is the truth the photo knows.
    expect(row.date).toBe("2026-03-09");
    const stored = fs.readFileSync(
      path.resolve(process.cwd(), row.stored_path)
    );
    const exif = readJpegExif(stored);
    expect(exif.hasExif).toBe(false);
    expect(exif.hasGps).toBe(false);
    // The grid's thumbnail lands beside it (no thumb_path column on this table).
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), thumbSiblingPath(row.stored_path))
      )
    ).toBe(true);

    // Dedup still keys on the PROCESSED bytes: the identical capture re-uploaded is a
    // calm success that adds no second row.
    const again = new FormData();
    again.set("lesion_id", String(lesionId));
    again.set(
      "photo",
      new File([new Uint8Array(tagged)], "mole.jpg", { type: "image/jpeg" })
    );
    expect((await uploadLesionPhoto(again)).ok).toBe(true);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM lesion_photos WHERE profile_id = ?`)
        .get(profile.id)
    ).toEqual({ n: 1 });
  });

  it("rejects a non-image upload", async () => {
    const { profile } = seedActor();
    await addSkinLesion(fd({ label: "Face spot", body_region: "face" }));
    const lesionId = getSkinLesions(profile.id)[0].id;
    const form = new FormData();
    form.set("lesion_id", String(lesionId));
    form.set(
      "photo",
      new File([Buffer.from("not an image")], "note.txt", {
        type: "text/plain",
      })
    );
    expect((await uploadLesionPhoto(form)).ok).toBe(false);
  });
});
