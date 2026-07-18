// SERVER-ACTION TIER — the mobility tap-the-moves log (issue #840). A mobility session is
// ONE `activities` row of type `recovery` per (profile, date); toggling a move updates its
// `components`, and the row is deleted when the session empties. Asserts the auth-gated
// action write path end-to-end against the real temp DB.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  logMobilityMove,
  unlogMobilityMove,
  setMobilityDuration,
} from "@/app/(app)/training/mobility-actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

const DATE = "2026-07-10";

function recoveryRows(profileId: number) {
  return db
    .prepare(
      `SELECT id, type, title, components, duration_min FROM activities
         WHERE profile_id = ? AND type = 'recovery' ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    type: string;
    title: string;
    components: string | null;
    duration_min: number | null;
  }[];
}

describe("mobility log actions", () => {
  it("logs a move into one recovery activity row, idempotently", async () => {
    const login = createLogin();
    const profile = createProfile("mobility-log", login.id);
    actAs(login, profile);

    const r1 = await logMobilityMove(fd({ move: "pigeon_pose", date: DATE }));
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.session.moves).toEqual(["pigeon_pose"]);

    const rows = recoveryRows(profile.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("recovery");
    // Components store the DISPLAY name (so the journal renders "Pigeon pose"); the slug
    // identity is recovered on read (session.moves is the canonical slug).
    const comps = JSON.parse(rows[0].components ?? "[]");
    expect(comps).toEqual([
      {
        name: "Pigeon pose",
        type: "recovery",
        distance_km: null,
        duration_min: null,
      },
    ]);

    // A second move joins the SAME row.
    const r2 = await logMobilityMove(
      fd({ move: "hamstring_stretch", date: DATE })
    );
    if (!r2.ok) throw new Error(r2.error);
    expect(new Set(r2.session.moves)).toEqual(
      new Set(["pigeon_pose", "hamstring_stretch"])
    );
    expect(recoveryRows(profile.id).length).toBe(1);

    // Re-logging an already-present move is idempotent (no duplicate component).
    const r3 = await logMobilityMove(fd({ move: "pigeon_pose", date: DATE }));
    if (!r3.ok) throw new Error(r3.error);
    expect(r3.session.moves.filter((m) => m === "pigeon_pose").length).toBe(1);
  });

  it("removes a move and deletes the empty session row", async () => {
    const login = createLogin();
    const profile = createProfile("mobility-unlog", login.id);
    actAs(login, profile);

    await logMobilityMove(fd({ move: "couch_stretch", date: DATE }));
    const off = await unlogMobilityMove(
      fd({ move: "couch_stretch", date: DATE })
    );
    if (!off.ok) throw new Error(off.error);
    expect(off.session.moves).toEqual([]);
    // No ghost row once the session empties (no moves and no duration).
    expect(recoveryRows(profile.id).length).toBe(0);
  });

  it("keeps the row when a duration remains after the last move is removed", async () => {
    const login = createLogin();
    const profile = createProfile("mobility-duration", login.id);
    actAs(login, profile);

    await logMobilityMove(fd({ move: "calf_stretch", date: DATE }));
    const dur = await setMobilityDuration(fd({ minutes: "15", date: DATE }));
    if (!dur.ok) throw new Error(dur.error);
    expect(dur.session.durationMin).toBe(15);

    const off = await unlogMobilityMove(
      fd({ move: "calf_stretch", date: DATE })
    );
    if (!off.ok) throw new Error(off.error);
    // Row survives because a duration remains.
    const rows = recoveryRows(profile.id);
    expect(rows.length).toBe(1);
    expect(rows[0].duration_min).toBe(15);
    expect(JSON.parse(rows[0].components ?? "[]")).toEqual([]);
  });

  it("rejects an unknown move slug", async () => {
    const login = createLogin();
    const profile = createProfile("mobility-bad", login.id);
    actAs(login, profile);

    const res = await logMobilityMove(fd({ move: "__nope__", date: DATE }));
    expect(res.ok).toBe(false);
    expect(recoveryRows(profile.id).length).toBe(0);
  });

  it("canonicalizes a fuzzy slug variant to the catalog slug (#883)", async () => {
    const login = createLogin();
    const profile = createProfile("mobility-canon", login.id);
    actAs(login, profile);

    // Hyphenated variant resolves to the stored snake_case slug.
    const res = await logMobilityMove(fd({ move: "pigeon-pose", date: DATE }));
    if (!res.ok) throw new Error(res.error);
    expect(res.session.moves).toEqual(["pigeon_pose"]);
  });
});
