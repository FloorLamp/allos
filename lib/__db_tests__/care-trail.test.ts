// DB INTEGRATION TIER (#1373 Part 2, the #448 builder rule). The care-trail gather
// against a real SQLite handle: a two-member fixture with a linked visit + a prescribed
// course nested under an episode, an UNLINKED routine visit held apart, a course whose
// prescriber matches the linked visit's provider (the provable chain), a not-in-view
// member excluded, and single-view = one member's output. The pure nesting/day/course
// math is unit-tested separately (lib/__tests__/care-trail.test.ts); this pins the
// end-to-end DB gather the profile-scoping static scan can't see across helpers.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { gatherCareTrail } from "@/lib/care-trail-gather";
import { buildCareTrail, careTrailRows } from "@/lib/care-trail";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newProvider(name: string, dedup: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)`
      )
      .run(name, dedup).lastInsertRowid
  );
}
function addEncounter(
  profileId: number,
  date: string,
  type: string,
  providerId: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, provider_id, source)
         VALUES (?, ?, ?, ?, 'manual')`
      )
      .run(profileId, date, type, providerId).lastInsertRowid
  );
}
function addEpisode(
  profileId: number,
  situation: string,
  startedAt: string | null,
  endedAt: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, situation, startedAt, endedAt).lastInsertRowid
  );
}
function linkVisit(profileId: number, episodeId: number, encounterId: number): void {
  db.prepare(
    `INSERT INTO episode_encounters (profile_id, episode_id, encounter_id)
     VALUES (?, ?, ?)`
  ).run(profileId, episodeId, encounterId);
}
function addMedication(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, priority, active, as_needed, rx)
         VALUES (?, ?, 'medication', 'high', 1, 0, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
}
function addCourse(
  itemId: number,
  startedOn: string,
  stoppedOn: string | null,
  stopReason: string | null,
  providerId: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, provider_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(itemId, startedOn, stoppedOn, stopReason, providerId).lastInsertRowid
  );
}

describe("care-trail gather — nesting, chain, not-in-view exclusion, single-view", () => {
  let a: number;
  let b: number;
  let now: string;
  let coldId: number;
  let urgentCareId: number;
  let dentalId: number;

  beforeAll(() => {
    a = newProfile("CT-A");
    b = newProfile("CT-B");
    now = today(a);
    const ng = newProvider("Dr. Ng", "ct-ng");

    // Member A: a Cold [now-6 .. now-1] closed, with a LINKED urgent-care visit on day 2
    // (now-5) and a prescribed Amoxicillin course started the same day, prescribed by the
    // same provider (Dr. Ng) → the provable chain. Plus an UNLINKED dental visit.
    coldId = addEpisode(a, "Cold", shiftDateStr(now, -6), shiftDateStr(now, -1));
    urgentCareId = addEncounter(a, shiftDateStr(now, -5), "Urgent care", ng);
    linkVisit(a, coldId, urgentCareId);
    dentalId = addEncounter(a, shiftDateStr(now, -3), "Dental");
    const amox = addMedication(a, "Amoxicillin");
    addCourse(amox, shiftDateStr(now, -5), shiftDateStr(now, 1), "completed_course", ng);

    // Member B: a lone Flu, no links/courses (for the not-in-view + single-view pins).
    addEpisode(b, "Flu", shiftDateStr(now, -20), shiftDateStr(now, -16));
  });

  it("nests the linked visit + course under the episode; holds the unlinked visit apart", () => {
    const gather = gatherCareTrail([a, b]);
    const build = buildCareTrail(gather.episodes, gather.visits, gather.courses);

    const cold = build.episodes.find((e) => e.episodeId === coldId)!;
    expect(cold).toBeTruthy();
    // linked urgent-care visit nested on Cold day 2
    expect(cold.linkedVisits.map((v) => v.encounterId)).toEqual([urgentCareId]);
    expect(cold.linkedVisits[0].dayNumber).toBe(2);
    expect(cold.linkedVisitCount).toBe(1);
    // Amoxicillin course nested with the provable chain to the urgent-care visit
    expect(cold.courses).toHaveLength(1);
    expect(cold.courses[0].medName).toBe("Amoxicillin");
    expect(cold.courses[0].dayNumber).toBe(2);
    expect(cold.courses[0].stateLabel).toBe("Completed");
    expect(cold.courses[0].chainVisit?.encounterId).toBe(urgentCareId);
    // the dental visit is UNLINKED — never nested, held apart for illness+visits
    expect(cold.linkedVisits.every((v) => v.encounterId !== dentalId)).toBe(
      true
    );
    expect(build.unlinkedVisits.some((v) => v.encounterId === dentalId)).toBe(
      true
    );
  });

  it("toggle: illness hides the unlinked visit; illness+visits shows it interleaved", () => {
    const gather = gatherCareTrail([a, b]);
    const build = buildCareTrail(gather.episodes, gather.visits, gather.courses);

    const illness = careTrailRows(build, "illness");
    expect(
      illness.some((r) => r.kind === "visit" && r.encounterId === dentalId)
    ).toBe(false);

    const withVisits = careTrailRows(build, "illness+visits");
    expect(
      withVisits.some((r) => r.kind === "visit" && r.encounterId === dentalId)
    ).toBe(true);
  });

  it("excludes a not-in-view member; single-view returns only that member", () => {
    const onlyA = gatherCareTrail([a]);
    expect(onlyA.episodes.every((e) => e.profileId === a)).toBe(true);
    expect(onlyA.visits.every((v) => v.profileId === a)).toBe(true);
    // B's Flu never appears in A's single-view gather
    expect(onlyA.episodes.some((e) => e.situation === "Flu")).toBe(false);

    const both = gatherCareTrail([a, b]);
    expect(both.episodes.some((e) => e.profileId === b)).toBe(true);
  });
});
