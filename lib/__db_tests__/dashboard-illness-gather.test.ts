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
  openEpisodeRowsForProfiles,
  reopenEligibleEpisodeForProfile,
  reopenEligibleFromState,
} from "@/lib/illness-episode-store";
import {
  currentEpisodeForProfile,
  currentEpisodeFromState,
  openEpisodeForProfile,
  openEpisodeFromState,
  openEpisodesFromState,
} from "@/lib/illness-episode";
import { isHouseholdRecentlySickFromStates } from "@/lib/household-history";
import { testAuthorizedIds } from "@/lib/__tests__/authorized-ids";
import { gatherDashboardIllnessCockpits } from "@/lib/dashboard-illness-cockpit";
import { withSettingReadCache } from "@/lib/settings";

// The three illness_episodes reads the dashboard path can issue, by signature. The
// today-row and closed-row queries are distinguishable in their WHERE clauses, which
// is what lets the pin say WHICH read collapsed rather than just "fewer of them".
const TODAY_ROW =
  /FROM illness_episodes[\s\S]*start_date IS NULL OR start_date <= \?/;
const CLOSED_ROW = /FROM illness_episodes[\s\S]*end_date IS NOT NULL/;
const OPEN_BY_SITUATION =
  /FROM illness_episodes[\s\S]*COLLATE NOCASE AND end_date IS NULL/;
const SYMPTOM_FACTS = /FROM symptom_logs[\s\S]*date >= \?[\s\S]*date <= \?/;
const TEMPERATURE_FACTS =
  /FROM medical_records[\s\S]*canonical_name = \?[\s\S]*date >= \?[\s\S]*date <= \?/;
const PRN_FACTS =
  /FROM intake_item_logs[\s\S]*obligation = 'may'[\s\S]*l\.date >= \?[\s\S]*l\.date <= \?/;

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

describe("multiple open illness episodes — one broad fact gather (#3138)", () => {
  it("partitions one symptom/temperature/PRN/condition gather across every open episode", () => {
    const p = newProfile("DIG-Multiple-open");
    const day = today(p);
    const olderDay = shiftDateStr(day, -4);
    const recentDay = shiftDateStr(day, -1);
    const olderId = addEpisode(p, "Flu", olderDay, null);

    addSymptom(p, shiftDateStr(day, -3), "cough", 2);
    addSymptom(p, day, "fever", 3);
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit,
          canonical_name, source, occurred_at)
       VALUES (?, ?, 'vitals', 'Body Temperature', '101.2', 101.2, 'degF',
               'Body Temperature', 'manual', ?)`
    ).run(p, day, `${day}T08:00:00Z`);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may')`
        )
        .run(p).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '200 mg', 'any', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, recorded_at, amount, status)
       VALUES (?, ?, ?, ?, '200 mg', 'taken')`
    ).run(doseId, itemId, day, `${day} 09:00:00`);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, onset_date)
       VALUES (?, 'Viral syndrome', 'active', ?)`
    ).run(p, day);

    const countFacts = () => {
      const [symptoms, temperatures, administrations] = countPrepareSet(
        SYMPTOM_FACTS,
        TEMPERATURE_FACTS,
        PRN_FACTS
      );
      const episodes = openEpisodesFromState(episodeStateForProfile(p), {
        includeEmpty: true,
      });
      const counts = [
        symptoms.calls(),
        temperatures.calls(),
        administrations.calls(),
      ];
      vi.restoreAllMocks();
      return { episodes, counts };
    };

    const one = countFacts();
    expect(one.episodes.map((episode) => episode.id)).toEqual([olderId]);
    expect(one.counts).toEqual([1, 1, 1]);

    const recentId = addEpisode(p, "Migraine", recentDay, null);
    const two = countFacts();
    expect(two.episodes.map((episode) => episode.id)).toEqual([
      recentId,
      olderId,
    ]);
    // Adding an episode partitions the same broad rows; it adds no fact query.
    expect(two.counts).toEqual(one.counts);

    const recent = two.episodes[0];
    const older = two.episodes[1];
    expect(recent.symptoms.map((series) => series.symptom)).toEqual(["fever"]);
    expect(older.symptoms.map((series) => series.symptom).sort()).toEqual([
      "cough",
      "fever",
    ]);
    for (const episode of two.episodes) {
      expect(episode.temperatures).toHaveLength(1);
      expect(episode.totalAdministrations).toBe(1);
      expect(episode.conditions.map((condition) => condition.name)).toEqual([
        "Viral syndrome",
      ]);
    }
  });

  it("gathers all and only the authorized set's open rows in one statement", () => {
    const first = newProfile("DIG-Authorized-first");
    const second = newProfile("DIG-Authorized-second");
    const ungranted = newProfile("DIG-Ungranted");
    const day = today(first);
    const firstOpen = addEpisode(first, "Flu", shiftDateStr(day, -2), null);
    const secondOpen = addEpisode(second, "Cold", shiftDateStr(day, -1), null);
    addEpisode(first, "Old flu", shiftDateStr(day, -8), shiftDateStr(day, -5));
    addEpisode(ungranted, "Private", shiftDateStr(day, -1), null);

    const [openSet] = countPrepareSet(
      /FROM illness_episodes[\s\S]*profile_id IN[\s\S]*end_date IS NULL/
    );
    const rows = openEpisodeRowsForProfiles(testAuthorizedIds([second, first]));

    expect(openSet.calls()).toBe(1);
    expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [firstOpen, secondOpen].sort((a, b) => a - b)
    );
    expect(rows.every((row) => row.end_date == null)).toBe(true);
    expect(rows.some((row) => row.profile_id === ungranted)).toBe(false);
  });

  it("does not add cockpit-control statements for a second open episode", () => {
    const p = newProfile("DIG-Cockpit-batch");
    const day = today(p);
    addEpisode(p, "Flu", shiftDateStr(day, -4), null);
    addSymptom(p, day, "cough", 2);

    const gatherCount = () => {
      const episodes = openEpisodesFromState(episodeStateForProfile(p), {
        includeEmpty: true,
      }).filter((episode): episode is typeof episode & { id: number } =>
        Number.isInteger(episode.id)
      );
      let statements = 0;
      const real = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        statements++;
        return real(sql);
      }) as typeof db.prepare);
      withSettingReadCache(() =>
        gatherDashboardIllnessCockpits(p, episodes, {
          canWrite: true,
          temperatureUnit: "F",
          weightUnit: "kg",
          now: new Date(`${day}T12:00:00Z`),
        })
      );
      vi.restoreAllMocks();
      return statements;
    };

    const one = gatherCount();
    addEpisode(p, "Migraine", shiftDateStr(day, -1), null);
    const two = gatherCount();
    expect(two).toBe(one);
  });
});
