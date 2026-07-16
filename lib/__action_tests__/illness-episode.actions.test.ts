// SERVER-ACTION TIER — illness-episode actions (issues #801/#856).
//
// Drives the real promote-to-condition / undo / episode-share / end actions through the
// (mocked) auth guard against a real temp DB. Post-#856 the actions resolve the episode
// by its STABLE ROW id (scoped to the profile), then bridge to a Condition, mint a share
// link, or end it. Asserts the auth gate (requireWriteAccess) and the rows written.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  promoteEpisodeToConditionAction,
  unpromoteEpisodeConditionAction,
  createEpisodeShareLinkAction,
  endEpisodeAction,
} from "@/app/(app)/medical/episodes/actions";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId } from "@/lib/settings";
import { getOpenEpisodeRow } from "@/lib/illness-episode-store";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Make the acting profile currently sick with an ongoing Illness episode ROW; return id.
function makeSick(profileId: number): number {
  resolveSituationId(profileId, "Illness"); // born illness_type=1
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  const start = shiftDateStr(today(profileId), -2);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, start);
  logSymptomCore(profileId, "cough", 2, today(profileId));
  return getOpenEpisodeRow(profileId, "Illness")!.id;
}

describe("promoteEpisodeToConditionAction", () => {
  let profileId: number;
  let episodeId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Promote Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    episodeId = makeSick(profileId);
  });

  it("creates an active episode-sourced condition, then undo removes it", async () => {
    const res = await promoteEpisodeToConditionAction(fd({ episodeId }));
    expect(res.ok).toBe(true);
    const row = db
      .prepare(
        `SELECT name, status, resolved_date, source, external_id
           FROM conditions WHERE profile_id = ?`
      )
      .get(profileId) as {
      name: string;
      status: string;
      resolved_date: string | null;
      source: string;
      external_id: string;
    };
    expect(row.name).toBe("Illness");
    expect(row.status).toBe("active"); // ongoing episode
    expect(row.resolved_date).toBeNull();
    expect(row.source).toBe("episode");

    // Idempotent re-promote, still one row.
    await promoteEpisodeToConditionAction(fd({ episodeId }));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(1);

    // Undo deletes it.
    const undo = await unpromoteEpisodeConditionAction(fd({ episodeId }));
    expect(undo.ok).toBe(true);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("rejects a garbage episode id without writing", async () => {
    const res = await promoteEpisodeToConditionAction(
      fd({ episodeId: "nope" })
    );
    expect(res.ok).toBe(false);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("errors when no episode row matches the id", async () => {
    const res = await promoteEpisodeToConditionAction(
      fd({ episodeId: episodeId + 9999 })
    );
    expect(res.ok).toBe(false);
  });
});

describe("endEpisodeAction", () => {
  it("closes the open episode row and deactivates the situation", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("End Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);

    const res = await endEpisodeAction(fd({ episodeId }));
    expect(res.ok).toBe(true);

    const row = db
      .prepare(`SELECT ended_at FROM illness_episodes WHERE id = ?`)
      .get(episodeId) as { ended_at: string | null };
    expect(row.ended_at).not.toBeNull();
    // The situation is deactivated (no open row remains).
    expect(getOpenEpisodeRow(profile.id, "Illness")).toBeNull();
  });
});

describe("createEpisodeShareLinkAction", () => {
  it("mints an episode-kind share link resolvable by token, anchored to the id", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Share Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);

    const res = await createEpisodeShareLinkAction(
      fd({ episodeId, ttl: "7d" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.path.replace("/share/", "");
    const link = getShareLinkByToken(token)!;
    expect(link.kind).toBe("episode");
    expect(link.profile_id).toBe(profile.id);
    expect(link.episode_id).toBe(episodeId);
    expect(link.episode_situation).toBe("Illness");
    expect(link.revoked_at).toBeNull();
  });

  it("is blocked for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO Actor", login.id);
    actAs(login, profile, "read");
    // makeSick uses profile writes; do it as write first, then downgrade.
    actAs(login, profile, "write");
    const episodeId = makeSick(profile.id);
    actAs(login, profile, "read");
    await expect(
      createEpisodeShareLinkAction(fd({ episodeId, ttl: "7d" }))
    ).rejects.toThrow(/read-only/);
  });
});
