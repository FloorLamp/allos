// DB INTEGRATION TIER — server-side FILTERED Training Log paging (issue #1634).
//
// #451 made the feed page by whole days server-side; its filters stayed in the
// client, over the LOADED pages only. A search for a session older than the fetched
// window therefore reported "no matches" while the row sat in `activities`. This
// pins the fix end to end:
//   • DEEP MATCHES SURFACE — a match many windows below the first page comes back on
//     page ONE of the filtered feed, with no cursor walking.
//   • THE CURSOR PAGES OVER MATCHES — nextBefore is computed over the filtered day
//     set, so walking it visits every matching day and stops.
//   • DERIVED FILTERS ARE FINITE PREIMAGES — the muscle/region tag (regionForExercise
//     is not SQL) and the fault filter (storedActivityFault is not SQL) resolve to
//     IN-lists over the profile's OWN data, so a free-text exercise name still maps.
//   • THE SUPERSET CONTRACT HOLDS — every day the pure predicate would accept a card
//     on is a day the SQL scan returns.
//   • PROFILE SCOPING — another profile's matching rows never enter a page.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getTrainingLogPage,
  resolveTrainingLogFilterSpec,
  getActivityFaults,
  getTrainingLogSourceKeys,
  getTrainingLogTagExercises,
} from "@/lib/queries";
import {
  buildTrainingLogFeedPage,
  buildMultiViewTrainingLogGroups,
} from "@/lib/training-log-feed";
import {
  EMPTY_TRAINING_LOG_FILTERS,
  filterTrainingLogGroups,
  trainingLogCardMatches,
  type TrainingLogFilters,
} from "@/lib/training-log-filters";
import { TRAINING_LOG_PAGE_DAYS } from "@/lib/training-log-feed";
import type { UnitPrefs } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

const filters = (over: Partial<TrainingLogFilters>): TrainingLogFilters => ({
  ...EMPTY_TRAINING_LOG_FILTERS,
  ...over,
});

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addActivity(
  profileId: number,
  opts: {
    date: string;
    title: string;
    type?: string;
    source?: string | null;
    components?: string | null;
    durationMin?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, components, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.date,
        opts.type ?? "cardio",
        opts.title,
        opts.durationMin === undefined ? 30 : opts.durationMin,
        opts.components ?? null,
        opts.source ?? null
      ).lastInsertRowid
  );
}

function addSet(
  activityId: number,
  exercise: string,
  over: { weightKg?: number | null; reps?: number | null; n?: number } = {}
): void {
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(
    activityId,
    exercise,
    over.n ?? 1,
    over.weightKg === undefined ? 60 : over.weightKg,
    over.reps === undefined ? 5 : over.reps
  );
}

const TODAY = "2026-07-12";
// Deep enough that the target sits well past the first TWO pages of the unfiltered
// feed (TRAINING_LOG_PAGE_DAYS = 14 per page).
const DEEP_OFFSET = 40;
const DEEP_DATE = shiftDateStr(TODAY, -DEEP_OFFSET);

let profileId: number;
let otherProfile: number;
let deepActivityId: number;

beforeAll(() => {
  profileId = newProfile("training-log-filter");
  otherProfile = newProfile("training-log-filter-other");

  // 60 consecutive days of ordinary sessions, so the newest window is nowhere near
  // the interesting rows below.
  for (let d = 0; d < 60; d++) {
    addActivity(profileId, {
      date: shiftDateStr(TODAY, -d),
      title: `Filler session ${d}`,
      components: JSON.stringify([
        { name: "Walking", type: "cardio", distance_km: 2, duration_min: 30 },
      ]),
    });
  }

  // THE deep match: an activity 40 days back whose title nothing else shares.
  deepActivityId = addActivity(profileId, {
    date: DEEP_DATE,
    title: "Kayaking on Reserved Lake",
    type: "sport",
    components: JSON.stringify([
      { name: "Kayaking", type: "sport", distance_km: 6, duration_min: 75 },
    ]),
  });

  // A deep STRENGTH session, for the region-tag preimage — the exercise name is
  // free text the catalog knows only through liftInfo's contains-fallback.
  const legDay = addActivity(profileId, {
    date: shiftDateStr(TODAY, -35),
    title: "Leg day",
    type: "strength",
    components: JSON.stringify([{ name: "Back Squat", type: "strength" }]),
  });
  addSet(legDay, "Back Squat", { weightKg: 100, reps: 5 });

  // A deep IMPORTED row and a deep MANUAL row on the SAME day, so the source
  // filter has to tell two same-day rows apart rather than two days.
  const mixedDay = shiftDateStr(TODAY, -30);
  addActivity(profileId, {
    date: mixedDay,
    title: "Tempo effort",
    source: "strava",
  });
  addActivity(profileId, { date: mixedDay, title: "Tempo cooldown" });
  // A document-extracted row: its raw source is unique per document, but it must
  // collapse into ONE "document" option.
  addActivity(profileId, {
    date: shiftDateStr(TODAY, -31),
    title: "Clinic treadmill test",
    source: "document:77",
  });

  // A deep FAULTY row: a strength session with components listing a part that has
  // a half-filled set (weight, no reps) — the editor can't re-save it.
  const faulty = addActivity(profileId, {
    date: shiftDateStr(TODAY, -45),
    title: "Legacy import",
    type: "strength",
    components: JSON.stringify([{ name: "Back Squat", type: "strength" }]),
  });
  addSet(faulty, "Back Squat", { weightKg: 80, reps: null });

  // Another profile's rows must never enter this profile's filtered pages.
  addActivity(otherProfile, {
    date: DEEP_DATE,
    title: "Kayaking on Reserved Lake",
    type: "sport",
  });
});

describe("getTrainingLogPage — filtered day selection (#1634)", () => {
  it("returns a match many windows deep on PAGE ONE, with no cursor walking", () => {
    // The unfiltered first page cannot reach it — that is the bug being fixed.
    const unfiltered = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS
    );
    expect(unfiltered.days).not.toContain(DEEP_DATE);

    const spec = resolveTrainingLogFilterSpec(
      profileId,
      filters({ query: "kayak" })
    );
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      spec
    );
    expect(page.days).toEqual([DEEP_DATE]);
    expect(page.activities.map((a) => a.id)).toContain(deepActivityId);
    // One matching day in the whole ledger, so nothing older to page to.
    expect(page.nextBefore).toBeNull();
  });

  it("matches the free text against titles, set names, and component names", () => {
    // Component name only ("Kayaking" is not in the title's words as typed).
    const byComponent = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ query: "kayaking" }))
    );
    expect(byComponent.days).toEqual([DEEP_DATE]);

    // Exercise-set name only — "Back Squat" appears in no title.
    const bySet = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ query: "back squat" }))
    );
    expect(bySet.days).toEqual([
      shiftDateStr(TODAY, -35),
      shiftDateStr(TODAY, -45),
    ]);
  });

  it("treats LIKE wildcards in the query as literal characters", () => {
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ query: "%" }))
    );
    expect(page.days).toEqual([]);
  });

  it("never leaks another profile's matching rows", () => {
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ query: "kayak" }))
    );
    for (const a of page.activities) {
      expect((a as unknown as { profile_id: number }).profile_id).toBe(
        profileId
      );
    }
  });

  it("pages the CURSOR over matching days, not over raw days", () => {
    // Every filler day matches "Filler", so a 2-day window has to walk them in
    // date order and stop exactly once the matching set is exhausted.
    const spec = resolveTrainingLogFilterSpec(
      profileId,
      filters({ query: "Filler" })
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const page: ReturnType<typeof getTrainingLogPage> = getTrainingLogPage(
        profileId,
        cursor,
        2,
        spec
      );
      seen.push(...page.days);
      cursor = page.nextBefore;
      if (cursor == null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(60);
    expect(seen[0]).toBe(TODAY);
    expect(seen[seen.length - 1]).toBe(shiftDateStr(TODAY, -59));
    // Strictly descending, no repeats — the #503 cursor-desync guard in filtered form.
    expect([...seen].sort().reverse()).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by activity type across the whole ledger", () => {
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ type: "sport" }))
    );
    expect(page.days).toEqual([DEEP_DATE]);
  });

  it("resolves the region tag as a finite IN-list preimage", () => {
    // The preimage is computed over the names this profile actually logged, not
    // over the catalog — regionForExercise cannot run in SQL.
    const names = getTrainingLogTagExercises(profileId, {
      kind: "region",
      value: "Legs",
    });
    expect(names).toContain("back squat");
    expect(names).not.toContain("walking");

    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(
        profileId,
        filters({ tag: { kind: "region", value: "Legs" } })
      )
    );
    expect(page.days).toEqual([
      shiftDateStr(TODAY, -35),
      shiftDateStr(TODAY, -45),
    ]);
  });

  it("returns nothing (not everything) when a preimage is empty", () => {
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(
        profileId,
        filters({ tag: { kind: "muscle", value: "Gills" } })
      )
    );
    expect(page.days).toEqual([]);
    expect(page.nextBefore).toBeNull();
  });

  it("filters by provenance, telling a manual row from an imported one on the SAME day", () => {
    const mixedDay = shiftDateStr(TODAY, -30);
    const strava = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ source: "strava" }))
    );
    expect(strava.days).toEqual([mixedDay]);
    // The DAY is the unit of selection, so both same-day rows come back; the pure
    // predicate is what separates them (asserted below through the built feed).
    const titles = strava.activities.map((a) => a.title);
    expect(titles).toContain("Tempo effort");
    expect(titles).toContain("Tempo cooldown");

    const manual = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ source: "manual" }))
    );
    // Manual rows are everywhere, but the imported day is reachable too.
    expect(manual.days).toContain(TODAY);

    // Every document-sourced row collapses into ONE option's selection.
    const doc = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ source: "document" }))
    );
    expect(doc.days).toEqual([shiftDateStr(TODAY, -31)]);
  });

  it("offers exactly one source option per provider", () => {
    expect(getTrainingLogSourceKeys(profileId)).toEqual([
      "manual",
      "document",
      "strava",
    ]);
  });

  it("filters to rows the editor can't re-save, from a preimage of ids", () => {
    const faults = getActivityFaults(profileId);
    expect(faults.count).toBe(1);
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, filters({ faultOnly: true }))
    );
    expect(page.days).toEqual([shiftDateStr(TODAY, -45)]);
  });

  it("ANDs filters — a type that excludes the text match yields nothing", () => {
    const page = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(
        profileId,
        filters({ query: "kayak", type: "strength" })
      )
    );
    expect(page.days).toEqual([]);
  });

  it("leaves the UNFILTERED page byte-identical to the pre-#1634 query", () => {
    const withNoSpec = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS
    );
    const withEmptyFilters = getTrainingLogPage(
      profileId,
      null,
      TRAINING_LOG_PAGE_DAYS,
      resolveTrainingLogFilterSpec(profileId, EMPTY_TRAINING_LOG_FILTERS)
    );
    expect(withEmptyFilters.days).toEqual(withNoSpec.days);
    expect(withEmptyFilters.activities.map((a) => a.id)).toEqual(
      withNoSpec.activities.map((a) => a.id)
    );
    expect(withEmptyFilters.nextBefore).toBe(withNoSpec.nextBefore);
  });
});

describe("buildTrainingLogFeedPage — built cards under a filter (#1634)", () => {
  it("builds the deep match's card on page one and the client predicate keeps it", () => {
    const page = buildTrainingLogFeedPage(
      profileId,
      null,
      UNITS,
      undefined,
      TRAINING_LOG_PAGE_DAYS,
      filters({ query: "kayak" })
    );
    const shown = filterTrainingLogGroups(
      page.groups,
      filters({ query: "kayak" })
    );
    expect(shown.map((g) => g.date)).toEqual([DEEP_DATE]);
    expect(shown[0].cards.map((c) => c.activity.id)).toEqual([deepActivityId]);
  });

  it("ships a matching day's OTHER rows too, so the merge picker keeps them", () => {
    const f = filters({ source: "strava" });
    const page = buildTrainingLogFeedPage(
      profileId,
      null,
      UNITS,
      undefined,
      TRAINING_LOG_PAGE_DAYS,
      f
    );
    // The raw page carries EVERY row of the matching day — the Strava effort, its
    // manual cooldown, and that day's filler session…
    expect(page.groups[0].cards.map((c) => c.activity.title).sort()).toEqual([
      "Filler session 30",
      "Tempo cooldown",
      "Tempo effort",
    ]);
    // …and the pure predicate is what narrows the DISPLAY to the imported one.
    const shown = filterTrainingLogGroups(page.groups, f);
    expect(shown[0].cards.map((c) => c.activity.title)).toEqual([
      "Tempo effort",
    ]);
  });

  it("SUPERSET CONTRACT: every card the predicate accepts is on a returned day", () => {
    // Walk the WHOLE filtered feed and the WHOLE unfiltered feed for the same
    // filters; the set of accepted card ids must be identical. This is the property
    // the fix rests on — SQL narrowing days must never drop a card the predicate
    // would have kept.
    for (const f of [
      filters({ query: "squat" }),
      filters({ type: "sport" }),
      filters({ source: "manual" }),
      filters({ faultOnly: true }),
      filters({ tag: { kind: "region", value: "Legs" } }),
    ]) {
      const filteredIds = new Set<number>();
      let cursor: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const page = buildTrainingLogFeedPage(
          profileId,
          cursor,
          UNITS,
          undefined,
          TRAINING_LOG_PAGE_DAYS,
          f
        );
        for (const g of filterTrainingLogGroups(page.groups, f))
          for (const c of g.cards) filteredIds.add(c.activity.id);
        cursor = page.nextBefore;
        if (cursor == null) break;
      }

      const allIds = new Set<number>();
      let plain: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const page = buildTrainingLogFeedPage(profileId, plain, UNITS);
        for (const g of page.groups)
          for (const c of g.cards)
            if (trainingLogCardMatches(c, f)) allIds.add(c.activity.id);
        plain = page.nextBefore;
        if (plain == null) break;
      }

      expect([...filteredIds].sort((a, b) => a - b)).toEqual(
        [...allIds].sort((a, b) => a - b)
      );
    }
  });
});

describe("buildMultiViewTrainingLogGroups — filters compose with per-member cursors (#1634)", () => {
  let memberA: number;
  let memberB: number;

  beforeAll(() => {
    memberA = newProfile("mv-filter-a");
    memberB = newProfile("mv-filter-b");
    // Each member's own filler history, so neither's match is on its own first page.
    for (const pid of [memberA, memberB]) {
      for (let d = 0; d < 30; d++) {
        addActivity(pid, {
          date: shiftDateStr(TODAY, -d),
          title: `Member filler ${d}`,
        });
      }
    }
    // Interleaving matches: A's is older than B's, so the merge has to order them.
    addActivity(memberA, {
      date: shiftDateStr(TODAY, -50),
      title: "Paddling upstream",
      type: "sport",
    });
    addActivity(memberB, {
      date: shiftDateStr(TODAY, -45),
      title: "Paddling downstream",
      type: "sport",
    });
  });

  it("surfaces EACH member's deep match, merged newest day first", () => {
    const f = filters({ query: "paddling" });
    const groups = buildMultiViewTrainingLogGroups(
      [memberA, memberB],
      memberA,
      UNITS,
      undefined,
      f
    );
    const shown = filterTrainingLogGroups(groups, f);
    expect(shown.map((g) => g.date)).toEqual([
      shiftDateStr(TODAY, -45),
      shiftDateStr(TODAY, -50),
    ]);
    expect(shown[0].cards[0].activity.title).toBe("Paddling downstream");
    expect(shown[0].cards[0].activity.subjectProfileId).toBe(memberB);
    expect(shown[1].cards[0].activity.subjectProfileId).toBe(memberA);
  });

  it("keeps the unfiltered merged window unchanged", () => {
    const groups = buildMultiViewTrainingLogGroups(
      [memberA, memberB],
      memberA,
      UNITS
    );
    // Newest window only, both members present, deep matches NOT pulled forward.
    expect(groups[0].date).toBe(TODAY);
    expect(groups.map((g) => g.date)).not.toContain(shiftDateStr(TODAY, -50));
  });
});
