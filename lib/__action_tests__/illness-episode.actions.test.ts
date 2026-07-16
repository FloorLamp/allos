// SERVER-ACTION TIER — illness-episode actions (issue #801).
//
// Drives the real promote-to-condition / undo / episode-share actions through the
// (mocked) auth guard against a real temp DB: the actions resolve the episode from an
// anchor date via the shared derivation, then bridge to a Condition or mint a share
// link. Asserts the auth gate (requireWriteAccess) and the rows actually written.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  promoteEpisodeToConditionAction,
  unpromoteEpisodeConditionAction,
  createEpisodeShareLinkAction,
} from "@/app/(app)/medical/episodes/actions";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId, setProfileSetting } from "@/lib/settings";
import { serializeSituationEvents } from "@/lib/trend-annotations";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Make the acting profile currently sick with an ongoing Illness episode.
function makeSick(profileId: number): string {
  resolveSituationId(profileId, "Illness"); // born illness_type=1
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  const start = shiftDateStr(today(profileId), -2);
  setProfileSetting(
    profileId,
    "situation_events",
    serializeSituationEvents(
      [],
      [{ date: start, situation: "Illness", change: "start" }]
    )
  );
  logSymptomCore(profileId, "cough", 2, today(profileId));
  return today(profileId);
}

describe("promoteEpisodeToConditionAction", () => {
  let profileId: number;
  let anchor: string;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Promote Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    anchor = makeSick(profileId);
  });

  it("creates an active episode-sourced condition, then undo removes it", async () => {
    const res = await promoteEpisodeToConditionAction(fd({ anchor }));
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
    await promoteEpisodeToConditionAction(fd({ anchor }));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(1);

    // Undo deletes it.
    const undo = await unpromoteEpisodeConditionAction(fd({ anchor }));
    expect(undo.ok).toBe(true);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("rejects a garbage anchor without writing", async () => {
    const res = await promoteEpisodeToConditionAction(fd({ anchor: "nope" }));
    expect(res.ok).toBe(false);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("errors when no episode covers the anchor day", async () => {
    // A day well before the episode start → no covering episode.
    const before = shiftDateStr(today(profileId), -400);
    const res = await promoteEpisodeToConditionAction(fd({ anchor: before }));
    expect(res.ok).toBe(false);
  });
});

describe("createEpisodeShareLinkAction", () => {
  it("mints an episode-kind share link resolvable by token", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Share Actor", login.id);
    actAs(login, profile);
    const anchor = makeSick(profile.id);

    const res = await createEpisodeShareLinkAction(fd({ anchor, ttl: "7d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.path.replace("/share/", "");
    const link = getShareLinkByToken(token)!;
    expect(link.kind).toBe("episode");
    expect(link.profile_id).toBe(profile.id);
    expect(link.episode_situation).toBe("Illness");
    expect(link.episode_anchor).toBe(anchor);
    expect(link.revoked_at).toBeNull();
  });

  it("is blocked for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO Actor", login.id);
    actAs(login, profile, "read");
    // makeSick uses profile writes; do it as write first, then downgrade.
    actAs(login, profile, "write");
    const anchor = makeSick(profile.id);
    actAs(login, profile, "read");
    await expect(
      createEpisodeShareLinkAction(fd({ anchor, ttl: "7d" }))
    ).rejects.toThrow(/read-only/);
  });
});
