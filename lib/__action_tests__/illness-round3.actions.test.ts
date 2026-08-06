// SERVER-ACTION TIER — the #859 round-3 episode actions: the stale-nudge one-tap
// BACKDATED end, the nudge dismissal, the symptom-photo attach/delete, and that
// route's accessible-profile serve gate (#1696). Drives each
// through the (mocked) auth guard against a real temp DB; asserts the auth gate wrote
// the expected rows and (for photos) files.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readJpegExif } from "@/lib/photo/exif";
import { spliceExifIntoJpeg } from "@/lib/photo/exif-fixture";
import { thumbSiblingPath } from "@/lib/photo/store";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { resolveSituationId, getProfileSetting } from "@/lib/settings";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { getOpenEpisodeRow, getEpisodeRow } from "@/lib/illness-episode-store";
import {
  endStaleEpisodeAction,
  dismissStaleNudgeAction,
  uploadSymptomPhotoAction,
  updateSymptomPhotoCaptionAction,
  deleteSymptomPhotoAction,
} from "@/app/(app)/medical/episodes/actions";
import { GET as serveSymptomPhoto } from "@/app/api/symptom-photo/[id]/route";
import { createLogin, createProfile, actAs, fd } from "./harness";

function makeSick(profileId: number, startDaysAgo = 8): number {
  resolveSituationId(profileId, "Illness");
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, shiftDateStr(today(profileId), -startDaysAgo));
  return getOpenEpisodeRow(profileId, "Illness")!.id;
}

// Real image bytes: since #1844 the upload runs through the shared photo core, which
// decodes and re-encodes the file, so a truncated-signature stub is no longer a
// stand-in for a photo. Each call paints a distinct colour so the per-profile
// content-hash dedup sees distinct captures.
let seed = 0;
async function photoFile(name = "rash.png"): Promise<File> {
  seed += 1;
  const bytes = await sharp({
    create: {
      width: 120,
      height: 90,
      channels: 3,
      background: { r: (seed * 37) % 255, g: 60, b: (seed * 61) % 255 },
    },
  })
    .png()
    .toBuffer();
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

describe("endStaleEpisodeAction — backdated one-tap close", () => {
  let profileId: number;
  let episodeId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Stale Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    episodeId = makeSick(profileId);
  });

  it("ends the episode as of the last active day (exclusive end = day+1) and deactivates", async () => {
    const lastActiveDay = shiftDateStr(today(profileId), -5);
    const res = await endStaleEpisodeAction(fd({ episodeId, lastActiveDay }));
    expect(res.ok).toBe(true);
    const row = getEpisodeRow(profileId, episodeId)!;
    expect(row.ended_at).toBe(shiftDateStr(lastActiveDay, 1));
    // The situation is no longer active (single source of truth kept coherent).
    const active = db
      .prepare(
        `SELECT active FROM situations WHERE profile_id = ? AND name = 'Illness'`
      )
      .get(profileId) as { active: number };
    expect(active.active).toBe(0);
  });

  it("refuses a missing/foreign episode id", async () => {
    const res = await endStaleEpisodeAction(
      fd({ episodeId: 999999, lastActiveDay: today(profileId) })
    );
    expect(res.ok).toBe(false);
  });
});

describe("dismissStaleNudgeAction", () => {
  it("records the episode id in the acked marker without changing the episode", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Dismiss Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);

    const res = await dismissStaleNudgeAction(fd({ episodeId }));
    expect(res.ok).toBe(true);
    const acked = JSON.parse(
      getProfileSetting(profile.id, "stale_nudge_acked") ?? "[]"
    );
    expect(acked).toContain(episodeId);
    // Episode itself untouched (still open).
    expect(getEpisodeRow(profile.id, episodeId)!.ended_at).toBeNull();
  });
});

describe("symptom photo attach / delete", () => {
  it("attaches a photo to a day (row + file) and deletes it (row + file gone)", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Photo Actor", login.id);
    actAs(login, profile);
    makeSick(profile.id);
    logSymptomCore(profile.id, "rash", 2, today(profile.id));

    const form = new FormData();
    form.set("photo", await photoFile());
    form.set("date", today(profile.id));
    form.set("symptom", "rash");
    form.set("caption", "left forearm");
    const res = await uploadSymptomPhotoAction(form);
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, stored_path, mime_type, caption FROM symptom_photos WHERE profile_id = ?`
      )
      .get(profile.id) as
      | {
          id: number;
          stored_path: string;
          mime_type: string;
          caption: string | null;
        }
      | undefined;
    expect(row).toBeTruthy();
    // The core re-encodes every accepted photo to JPEG on the way in — the stored
    // mime is the PIPELINE's, never the uploaded container's.
    expect(row!.mime_type).toBe("image/jpeg");
    expect(row!.caption).toBe("left forearm");
    expect(fs.existsSync(row!.stored_path)).toBe(true);

    const editRes = await updateSymptomPhotoCaptionAction(
      fd({ photoId: row!.id, caption: "Improving after two days" })
    );
    expect(editRes.ok).toBe(true);
    expect(
      db
        .prepare(
          `SELECT caption FROM symptom_photos WHERE id = ? AND profile_id = ?`
        )
        .get(row!.id, profile.id)
    ).toEqual({ caption: "Improving after two days" });

    const delRes = await deleteSymptomPhotoAction(fd({ photoId: row!.id }));
    expect(delRes.ok).toBe(true);
    expect(
      db.prepare(`SELECT 1 FROM symptom_photos WHERE id = ?`).get(row!.id)
    ).toBeUndefined();
    expect(fs.existsSync(row!.stored_path)).toBe(false);
  });

  // The load-bearing #1844 pin: a photo of a child's rash is among the most sensitive
  // images this app holds, and until phase 3 it went to disk with whatever the phone
  // wrote into it. The action never trusts the client's bytes.
  it("stores a metadata-free file even when the upload carries GPS EXIF", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Photo Strip Actor", login.id);
    actAs(login, profile);
    const base = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 200, g: 80, b: 80 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const tagged = spliceExifIntoJpeg(base, {
      dateTimeOriginal: "2026:01:20 11:05:00",
      gps: true,
    });
    expect(readJpegExif(tagged).hasGps).toBe(true); // the fixture has teeth

    const form = new FormData();
    form.set(
      "photo",
      new File([new Uint8Array(tagged)], "rash.jpg", { type: "image/jpeg" })
    );
    form.set("date", today(profile.id));
    expect((await uploadSymptomPhotoAction(form)).ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id, date, stored_path FROM symptom_photos WHERE profile_id = ?`
      )
      .get(profile.id) as { id: number; date: string; stored_path: string };
    // The episode DAY the strip stands on wins over the EXIF capture date — the
    // explicit date is the user's answer, the harvest only fills a blank.
    expect(row.date).toBe(today(profile.id));
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
    again.set(
      "photo",
      new File([new Uint8Array(tagged)], "rash.jpg", { type: "image/jpeg" })
    );
    again.set("date", today(profile.id));
    expect((await uploadSymptomPhotoAction(again)).ok).toBe(true);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM symptom_photos WHERE profile_id = ?`
        )
        .get(profile.id)
    ).toEqual({ n: 1 });
  });

  it("rejects a non-image file", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Photo Reject", login.id);
    actAs(login, profile);
    const form = new FormData();
    form.set(
      "photo",
      new File([Buffer.from("not an image")], "note.txt", {
        type: "text/plain",
      })
    );
    form.set("date", today(profile.id));
    const res = await uploadSymptomPhotoAction(form);
    expect(res.ok).toBe(false);
  });

  it("does not edit a photo owned by another profile", async () => {
    const login = createLogin({ role: "admin" });
    const owner = createProfile("Photo Owner", login.id);
    const actor = createProfile("Photo Editor", login.id);
    actAs(login, owner);
    const form = new FormData();
    form.set("photo", await photoFile("owned.png"));
    form.set("date", today(owner.id));
    expect((await uploadSymptomPhotoAction(form)).ok).toBe(true);
    const row = db
      .prepare(`SELECT id FROM symptom_photos WHERE profile_id = ?`)
      .get(owner.id) as { id: number };

    actAs(login, actor);
    const res = await updateSymptomPhotoCaptionAction(
      fd({ photoId: row.id, caption: "wrong profile" })
    );
    expect(res.ok).toBe(false);
    expect(
      db
        .prepare(
          `SELECT caption FROM symptom_photos WHERE id = ? AND profile_id = ?`
        )
        .get(row.id, owner.id)
    ).toEqual({ caption: null });
  });
});

describe("symptom photo serve route — accessible-profile access (#1696)", () => {
  it("serves a household member's photo to a caregiver acting as another profile, and refuses an ungranted login", async () => {
    // Same mismatch as the clip route beside it: the photo strip renders on the episode
    // page, which resolves the episode across the viewer's ACCESSIBLE profiles (#879),
    // so ACTIVE-profile scoping 404'd every thumbnail a caregiver looked at.
    const caregiver = createLogin({ role: "member" });
    const parent = createProfile("Photo Parent 9", caregiver.id);
    const member = createProfile("Photo Member 9", caregiver.id);

    actAs(caregiver, member);
    const form = new FormData();
    form.set("photo", await photoFile("member-rash.png"));
    form.set("date", today(member.id));
    expect((await uploadSymptomPhotoAction(form)).ok).toBe(true);
    const row = db
      .prepare(`SELECT id FROM symptom_photos WHERE profile_id = ?`)
      .get(member.id) as { id: number };

    actAs(caregiver, parent);
    const served = await serveSymptomPhoto(
      new Request(`http://test/api/symptom-photo/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    // The grants boundary is untouched: a login with no grant on the owning profile is
    // refused exactly as a nonexistent id is.
    const stranger = createLogin({ role: "member" });
    actAs(stranger, createProfile("Photo Stranger 9", stranger.id));
    const denied = await serveSymptomPhoto(
      new Request(`http://test/api/symptom-photo/${row.id}`),
      { params: Promise.resolve({ id: String(row.id) }) }
    );
    expect(denied.status).toBe(404);
    const missing = await serveSymptomPhoto(
      new Request(`http://test/api/symptom-photo/99999999`),
      { params: Promise.resolve({ id: "99999999" }) }
    );
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });
});
