// SERVER-ACTION TIER — the #859 round-3 episode actions: the stale-nudge one-tap
// BACKDATED end, the nudge dismissal, and the symptom-photo attach/delete. Drives each
// through the (mocked) auth guard against a real temp DB; asserts the auth gate wrote
// the expected rows and (for photos) files.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
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

// A minimal valid PNG (signature + a truncated body) — enough for the magic-byte sniff.
function pngFile(name = "rash.png"): File {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.concat([sig, Buffer.from("synthetic-fixture-bytes")]);
  return new File([body], name, { type: "image/png" });
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
    form.set("photo", pngFile());
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
    expect(row!.mime_type).toBe("image/png");
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
    form.set("photo", pngFile("owned.png"));
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
