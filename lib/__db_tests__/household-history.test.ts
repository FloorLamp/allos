// DB INTEGRATION TIER (issue #1009). The merged cross-profile household history
// gather against a real SQLite handle: three profiles with interleaved visits +
// illness episodes prove the merged stream is date-ordered and person-tagged, the
// per-person filter narrows, a partial accessible set sees only its own profiles
// (the access pin — the gather is auth-blind but the resolved id list is the boundary),
// the contextual-promotion predicate fires only for a currently/recently-sick set, and
// the episode-card window gather returns overlapping/adjacent episodes and nothing when
// none. The pure merge/overlap/recency math is unit-tested separately; this pins the
// end-to-end DB gather (the profile-scoping static scan can't see across the helpers).

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  gatherHouseholdHistory,
  isHouseholdRecentlySick,
  gatherHouseholdEpisodeContext,
} from "@/lib/household-history";
import { summarizeEpisodesForProfile } from "@/lib/illness-episode-summary";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addEncounter(profileId: number, date: string, type: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, source)
         VALUES (?, ?, ?, 'manual')`
      )
      .run(profileId, date, type).lastInsertRowid
  );
}

// A stored illness episode row; started/ended are inclusive-start / EXCLUSIVE-end
// (null end = ongoing), matching the illness domain's semantics.
function addEpisode(
  profileId: number,
  startedAt: string | null,
  endedAt: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(profileId, startedAt, endedAt).lastInsertRowid
  );
}

describe("household history — merged gather, access pin, promotion, episode context", () => {
  let p1: number;
  let p2: number;
  let p3: number;
  let pWell: number;
  let pRecent: number;
  let now: string;

  beforeAll(() => {
    p1 = newProfile("HH-One");
    p2 = newProfile("HH-Two");
    p3 = newProfile("HH-Three");
    pWell = newProfile("HH-Well");
    pRecent = newProfile("HH-Recent");
    now = today(p1);

    // p1: an old visit + a closed episode [now-30, now-26] (ended_at exclusive now-25).
    addEncounter(p1, shiftDateStr(now, -40), "Annual physical");
    addEpisode(p1, shiftDateStr(now, -30), shiftDateStr(now, -25));

    // p2: a more recent visit + a closed episode [now-28, now-25] that OVERLAPS p1's.
    addEncounter(p2, shiftDateStr(now, -10), "Sick visit");
    addEpisode(p2, shiftDateStr(now, -28), shiftDateStr(now, -24));

    // p3: currently sick (open episode covering today) + a far-past closed episode.
    addEpisode(p3, shiftDateStr(now, -2), null);
    addEpisode(p3, shiftDateStr(now, -200), shiftDateStr(now, -195));

    // pWell: no illness at all. pRecent: an episode that closed 5 days ago (within the
    // 14-day recency window).
    addEncounter(pWell, shiftDateStr(now, -3), "Dental cleaning");
    addEpisode(pRecent, shiftDateStr(now, -12), shiftDateStr(now, -5));
  });

  it("merges every accessible profile's visits + episodes, newest first, tagged by person", () => {
    const items = gatherHouseholdHistory([p1, p2, p3]);

    // Every row is tagged with its owning profile, and only the three profiles appear.
    const owners = new Set(items.map((i) => i.profileId));
    expect(owners).toEqual(new Set([p1, p2, p3]));

    // The stream is date-ordered, most-recent first (non-increasing sort keys).
    const sortKeys = items.map((i) =>
      i.kind === "visit" ? i.date : (i.firstDay ?? i.start ?? "")
    );
    const sorted = [...sortKeys].sort().reverse();
    expect(sortKeys).toEqual(sorted);

    // Both kinds are present.
    expect(items.some((i) => i.kind === "visit")).toBe(true);
    expect(items.some((i) => i.kind === "episode")).toBe(true);
  });

  it("narrows to one person when filtered by profile (the per-person view)", () => {
    const items = gatherHouseholdHistory([p1, p2, p3]);
    const justP2 = items.filter((i) => i.profileId === p2);
    // p2 has exactly one visit + one episode.
    expect(justP2).toHaveLength(2);
    expect(justP2.every((i) => i.profileId === p2)).toBe(true);
  });

  it("shows only the accessible profiles (grant access pin)", () => {
    // A login granted only p1 + p2 must never see p3's rows.
    const items = gatherHouseholdHistory([p1, p2]);
    expect(items.some((i) => i.profileId === p3)).toBe(false);
    expect(new Set(items.map((i) => i.profileId))).toEqual(new Set([p1, p2]));
  });

  it("promotes when any accessible profile is currently or recently sick", () => {
    // p3 is currently sick (open episode covers today).
    expect(isHouseholdRecentlySick([p3])).toBe(true);
    // pRecent closed an episode 5 days ago → within the recency window.
    expect(isHouseholdRecentlySick([pRecent])).toBe(true);
    // Mixed set with a sick member → true.
    expect(isHouseholdRecentlySick([pWell, p3])).toBe(true);
  });

  it("does not promote when no accessible profile is currently or recently sick", () => {
    // pWell has no illness; p1's only episode closed 26 days ago (outside 14).
    expect(isHouseholdRecentlySick([pWell])).toBe(false);
    expect(isHouseholdRecentlySick([p1])).toBe(false);
    expect(isHouseholdRecentlySick([pWell, p1])).toBe(false);
  });

  it("returns overlapping/adjacent members' episodes for the episode-page card", () => {
    // Focal = p2's closed episode; other accessible members p1 + p3.
    const focalEp = summarizeEpisodesForProfile(p2)[0];
    const ctx = gatherHouseholdEpisodeContext(
      p2,
      { firstDay: focalEp.firstDay, lastActiveDay: focalEp.lastActiveDay },
      [p1, p3]
    );
    // p1 overlaps p2's window; p3's episodes are far away → excluded.
    expect(ctx).toHaveLength(1);
    expect(ctx[0].profileId).toBe(p1);
    expect(ctx[0].relation).toBe("overlap");
    expect(ctx[0].days).toBeGreaterThan(0);
  });

  it("returns nothing for the card when no other member's illness is near", () => {
    // Focal = p3's open episode (now-2 .. today); p1 + p2's episodes are ~23+ days off.
    const openEp = summarizeEpisodesForProfile(p3).find((e) => e.ongoing)!;
    const ctx = gatherHouseholdEpisodeContext(
      p3,
      { firstDay: openEp.firstDay, lastActiveDay: openEp.lastActiveDay },
      [p1, p2]
    );
    expect(ctx).toEqual([]);
  });
});
