// DB INTEGRATION TIER — the dashboard's per-profile illness reads (#2115 + #2446).
//
// One dashboard render used to ask about each accessible profile's illness episodes
// THREE independent times: the hero accordion read the row covering that member's
// today, the reopen band read the most-recently CLOSED row, and the household-history
// promo read BOTH again — so the closed-row SELECT ran twice per profile per render
// for two derivations of one fact, while the page's own comment claimed the reuse.
//
// The fix is structural, not a memo: one gather (episodeStatesForProfiles) hands the
// two rows down and the three surfaces are pure derivations of it. So the bar is the
// #2509 bar — BEHAVIOUR UNCHANGED — and the pins here are of two kinds:
//
//   • ANSWER pins: each derivation equals the per-profile function it replaced, on
//     every state that matters (currently sick, just resolved, resolved-and-reopened,
//     long recovered, never sick, and an id with no rows at all);
//   • STATEMENT-COUNT pins: the gather-and-derive path issues two illness_episodes
//     reads per profile plus one only for a profile that is actually reopen-eligible,
//     where the old path issued five. Counted rather than claimed, because "fewer
//     queries" is the whole point of the change.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no
// network.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  episodeStateForProfile,
  episodeStatesForProfiles,
  reopenEligibleEpisodeForProfile,
  reopenEligibleFromState,
} from "@/lib/illness-episode-store";
import {
  currentEpisodeForProfile,
  currentEpisodeFromState,
  openEpisodeForProfile,
  openEpisodeFromState,
} from "@/lib/illness-episode";
import { isHouseholdRecentlySickFromStates } from "@/lib/household-history";

// The three illness_episodes reads the dashboard path can issue, by signature. The
// today-row and closed-row queries are distinguishable in their WHERE clauses, which
// is what lets the pin say WHICH read collapsed rather than just "fewer of them".
const TODAY_ROW =
  /FROM illness_episodes[\s\S]*start_date IS NULL OR start_date <= \?/;
const CLOSED_ROW = /FROM illness_episodes[\s\S]*end_date IS NOT NULL/;
const OPEN_BY_SITUATION =
  /FROM illness_episodes[\s\S]*COLLATE NOCASE AND end_date IS NULL/;

// One spy fanned out over several signatures — vi.spyOn returns the SAME spy for an
// already-spied method, so two independent spies would leave the second calling
// through to itself.
function countPrepareSet(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

function addEpisode(
  profileId: number,
  situation: string,
  startDate: string | null,
  endDate: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, situation, startDate, endDate).lastInsertRowid
  );
}

function addSymptom(
  profileId: number,
  date: string,
  symptom: string,
  severity: number
): void {
  db.prepare(
    "INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?, ?, ?, ?)"
  ).run(profileId, date, symptom, severity);
}

describe("dashboard illness gather — one read per fact, per profile", () => {
  let pSick: number;
  let pReopen: number;
  let pReopened: number;
  let pOld: number;
  let pNever: number;
  let all: number[];
  let now: string;

  beforeAll(() => {
    pSick = newProfile("DIG-Sick");
    pReopen = newProfile("DIG-Reopen");
    pReopened = newProfile("DIG-Reopened");
    pOld = newProfile("DIG-Old");
    pNever = newProfile("DIG-Never");
    all = [pSick, pReopen, pReopened, pOld, pNever];
    now = today(pSick);

    // Currently sick: an open episode covering today, WITH a signal — the accordion
    // is signal-gated on purpose (a not-yet-symptomatic member stays off the list),
    // so a bare open row would leave that state untested.
    addEpisode(pSick, "Illness", shiftDateStr(now, -2), null);
    addSymptom(pSick, shiftDateStr(now, -1), "headache", 2);
    // Just resolved: closed three days ago, inside the 7-day reopen window.
    addEpisode(
      pReopen,
      "Illness",
      shiftDateStr(now, -9),
      shiftDateStr(now, -3)
    );
    // Resolved AND opened again under the same name — in the reopen window by date,
    // but not offered a reopen line because that situation is live.
    addEpisode(
      pReopened,
      "Cold",
      shiftDateStr(now, -14),
      shiftDateStr(now, -4)
    );
    addEpisode(pReopened, "Cold", shiftDateStr(now, -1), null);
    // Long recovered: outside both the 7-day reopen and the 14-day promo windows.
    addEpisode(pOld, "Illness", shiftDateStr(now, -40), shiftDateStr(now, -30));
    // pNever: no episode rows at all.
  });

  it("derives the accordion, the hero cockpit and the reopen line exactly as the per-profile reads did", () => {
    for (const pid of all) {
      const state = episodeStateForProfile(pid);
      expect(currentEpisodeFromState(state)).toEqual(
        currentEpisodeForProfile(pid)
      );
      expect(openEpisodeFromState(state)).toEqual(openEpisodeForProfile(pid));
      expect(reopenEligibleFromState(state)).toEqual(
        reopenEligibleEpisodeForProfile(pid)
      );
    }
  });

  it("answers the same for a profile id with no rows at all", () => {
    // Not reachable through the auth boundary, but the derivations must return the
    // absent answer rather than throw or invent one — the empty case an off-by-one
    // in a gather hides best.
    const foreign = 987654;
    const state = episodeStateForProfile(foreign);
    expect(state.todayRow).toBeNull();
    expect(state.mostRecentClosed).toBeNull();
    expect(currentEpisodeFromState(state)).toBeNull();
    expect(openEpisodeFromState(state)).toBeNull();
    expect(reopenEligibleFromState(state)).toBeNull();
    expect(isHouseholdRecentlySickFromStates([state])).toBe(false);
  });

  it("names the right subject in each state", () => {
    // The states are only useful if the fixture actually spans them, so pin what
    // each one answers rather than only that old and new agree.
    expect(
      currentEpisodeFromState(episodeStateForProfile(pSick))
    ).not.toBeNull();
    expect(reopenEligibleFromState(episodeStateForProfile(pSick))).toBeNull();

    expect(
      reopenEligibleFromState(episodeStateForProfile(pReopen))?.situation
    ).toBe("Illness");
    // Same situation open again → a cockpit, not a reopen prompt.
    expect(
      reopenEligibleFromState(episodeStateForProfile(pReopened))
    ).toBeNull();

    expect(reopenEligibleFromState(episodeStateForProfile(pOld))).toBeNull();
    expect(reopenEligibleFromState(episodeStateForProfile(pNever))).toBeNull();
  });

  it("promotes household history on exactly the members the old predicate did", () => {
    const states = (ids: number[]) => episodeStatesForProfiles(ids);
    expect(isHouseholdRecentlySickFromStates(states([pSick]))).toBe(true);
    expect(isHouseholdRecentlySickFromStates(states([pReopen]))).toBe(true);
    expect(isHouseholdRecentlySickFromStates(states([pReopened]))).toBe(true);
    expect(isHouseholdRecentlySickFromStates(states([pOld]))).toBe(false);
    expect(isHouseholdRecentlySickFromStates(states([pNever]))).toBe(false);
    expect(isHouseholdRecentlySickFromStates(states([]))).toBe(false);
    expect(isHouseholdRecentlySickFromStates(states([pOld, pNever]))).toBe(
      false
    );
    expect(isHouseholdRecentlySickFromStates(states([pOld, pSick]))).toBe(true);
  });

  it("reads each profile's two episode rows ONCE for all three derivations", () => {
    const [todayRow, closedRow, openBySituation] = countPrepareSet(
      TODAY_ROW,
      CLOSED_ROW,
      OPEN_BY_SITUATION
    );

    // Exactly what the dashboard does with the gather: accordion + hero + reopen
    // band + the recently-sick promo, over one state per member.
    const states = episodeStatesForProfiles(all);
    for (const s of states) {
      currentEpisodeFromState(s);
      openEpisodeFromState(s);
      reopenEligibleFromState(s);
    }
    isHouseholdRecentlySickFromStates(states);

    expect(todayRow.calls()).toBe(all.length);
    expect(closedRow.calls()).toBe(all.length);
    // Only the two members whose most-recent closed episode is still inside the
    // 7-day window pay the "is that situation open again?" check.
    expect(openBySituation.calls()).toBe(2);
  });

  it("issues strictly fewer statements than the pre-#2115 four-call path", () => {
    const [todayRow, closedRow, openBySituation] = countPrepareSet(
      TODAY_ROW,
      CLOSED_ROW,
      OPEN_BY_SITUATION
    );

    // The dashboard's reads EXACTLY as they were before this change: the accordion's
    // currentEpisodeForProfile, the hero's openEpisodeForProfile, the reopen band's
    // reopenEligibleEpisodeForProfile, and the promo's own two reads per profile.
    for (const pid of all) {
      currentEpisodeForProfile(pid);
      openEpisodeForProfile(pid);
      reopenEligibleEpisodeForProfile(pid);
      // isHouseholdRecentlySick's per-profile body, inlined — it took ids and read
      // both rows again for every member it looked at.
      episodeStateForProfile(pid);
    }

    // 5 profiles × (accordion + hero + promo today-row) and × (reopen + promo
    // closed-row): the duplication the issue reported, counted.
    expect(todayRow.calls()).toBe(all.length * 3);
    expect(closedRow.calls()).toBe(all.length * 2);
    expect(openBySituation.calls()).toBe(2);
  });
});
