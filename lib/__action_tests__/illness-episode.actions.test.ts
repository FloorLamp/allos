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
  editEpisodeAction,
  createEpisodeAction,
  mergeEpisodesAction,
} from "@/app/(app)/medical/episodes/actions";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId } from "@/lib/settings";
import {
  getEpisodeRow,
  getOpenEpisodeRow,
  listEpisodeRows,
} from "@/lib/illness-episode-store";
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

// Insert a CLOSED episode row directly; return its id.
function createEpisodeRowFor(
  profileId: number,
  start: string,
  end: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(profileId, start, end).lastInsertRowid
  );
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

describe("editEpisodeAction (boundaries + annotations, item 1)", () => {
  it("edits a closed episode's dates, note, and outcome as a plain row edit", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Edit Actor", login.id);
    actAs(login, profile);
    const newId = createEpisodeRowFor(profile.id, "2026-05-01", "2026-05-06");

    const res = await editEpisodeAction(
      fd({
        episodeId: newId,
        startedAt: "2026-04-30",
        endedAt: "2026-05-05",
        note: "pediatrician said rest",
        outcome: "self-resolved",
      })
    );
    expect(res.ok).toBe(true);
    const row = getEpisodeRow(profile.id, newId)!;
    expect(row.started_at).toBe("2026-04-30");
    expect(row.ended_at).toBe("2026-05-05");
    expect(row.note).toBe("pediatrician said rest");
    expect(row.outcome).toBe("self-resolved");
  });

  it("rejects an end on-or-before the start", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Bad Range", login.id);
    actAs(login, profile);
    const newId = createEpisodeRowFor(profile.id, "2026-05-01", "2026-05-06");
    const res = await editEpisodeAction(
      fd({ episodeId: newId, startedAt: "2026-05-05", endedAt: "2026-05-05" })
    );
    expect(res.ok).toBe(false);
  });

  it("keeps an OPEN episode's end null (the toggle owns closing it)", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Open Edit", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);
    await editEpisodeAction(
      fd({ episodeId, startedAt: "2026-05-01", endedAt: "2026-05-04" })
    );
    expect(getEpisodeRow(profile.id, episodeId)!.ended_at).toBeNull();
  });
});

describe("createEpisodeAction + mergeEpisodesAction (retro + flap-merge, item 1)", () => {
  it("retro-creates a closed episode", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Retro", login.id);
    actAs(login, profile);
    const res = await createEpisodeAction(
      fd({
        situation: "Illness",
        startedAt: "2026-03-01",
        endedAt: "2026-03-05",
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = getEpisodeRow(profile.id, res.id)!;
    expect(row.started_at).toBe("2026-03-01");
    expect(row.ended_at).toBe("2026-03-05");
  });

  it("merges a flap-split pair into the union range, deleting the loser", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Merge", login.id);
    actAs(login, profile);
    const a = createEpisodeRowFor(profile.id, "2026-02-01", "2026-02-02");
    const b = createEpisodeRowFor(profile.id, "2026-02-02", "2026-02-06");
    const res = await mergeEpisodesAction(fd({ keepId: a, dropId: b }));
    expect(res.ok).toBe(true);
    const keeper = getEpisodeRow(profile.id, a)!;
    expect(keeper.started_at).toBe("2026-02-01");
    expect(keeper.ended_at).toBe("2026-02-06");
    expect(getEpisodeRow(profile.id, b)).toBeNull();
    expect(listEpisodeRows(profile.id).length).toBe(1);
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
