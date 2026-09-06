// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #839 — endurance event plans. Seeds a realistic fixture (a 10k plan + logged runs
// across weeks) and asserts the END-TO-END gather output: the recomputed this-week
// trajectory targets, long-run detection (Strava label else longest-of-week), the taper
// flip, the coaching-tier long-session finding (with the illness pause), completion →
// timeline milestone, and one-active-per-discipline. The #448-style builder fixture: the
// finding builder's INPUT LAYER (discipline volume + this-week actuals) is what the pure
// tier can't see, so it's exercised here against real rows.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getEndurancePlanCard,
  getEndurancePlanCards,
  getEnduranceArm,
  getEnduranceEvents,
  getWorkoutActivityDays,
} from "@/lib/queries";
import { buildEndurancePlanFindings } from "@/lib/rule-findings";
import {
  createEndurancePlanCore,
  getActiveEndurancePlans,
  getEndurancePlan,
  setEndurancePlanStatusCore,
  deleteEndurancePlanCore,
  linkEventActivityCore,
  linkRaceActivityCore,
  unlinkEventActivityCore,
} from "@/lib/endurance-plans";
import { coachedPlan, enduranceLongSessionKey } from "@/lib/endurance-plan";
import { getEventDay } from "@/lib/queries/endurance";
import { upsertActivities } from "@/lib/integrations/normalize";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import { snapshotKeeperFold, writeActivityFold } from "@/lib/merge-activity";
import { toKm } from "@/lib/units";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addRun(
  profileId: number,
  date: string,
  distanceKm: number,
  workoutType: string | null = null,
  title = "Running"
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, distance_km, workout_type)
     VALUES (?, ?, 'cardio', ?, ?, ?)`
  ).run(profileId, date, title, distanceKm, workoutType);
}

// today = Monday 2026-06-15; default week start is Sunday (0), so this week begins
// 2026-06-14 and the prior COMPLETED week is 2026-06-07…06-13.
const TODAY = "2026-06-15";

function seedPlanFixture(): { profileId: number; planId: number } {
  const profileId = makeProfile("endurance-fixture");
  // Last completed week: 6 + 7 + 7 = 20 km (the base the trajectory projects from).
  addRun(profileId, "2026-06-08", 6);
  addRun(profileId, "2026-06-10", 7);
  addRun(profileId, "2026-06-12", 7);
  // This week: a 12 km UNLABELED run + an 8 km Strava "long run" — detection must pick
  // the labeled 8, not the raw-longest 12.
  addRun(profileId, "2026-06-15", 12);
  addRun(profileId, "2026-06-16", 8, "long run");
  const out = createEndurancePlanCore(profileId, {
    eventName: "Test 10k",
    discipline: "run",
    eventDate: "2026-10-05", // ~16 weeks out — feasible for a 10k
    targetDistanceKm: 10,
  });
  expect(out.kind).toBe("ok");
  return { profileId, planId: (out as { kind: "ok"; id: number }).id };
}

describe("endurance plan card — trajectory + actuals (#839)", () => {
  it("computes this-week targets from the last completed week and this week's actuals", () => {
    const { profileId, planId } = seedPlanFixture();
    const plan = getEndurancePlan(profileId, planId)!;
    const card = getEndurancePlanCard(profileId, coachedPlan(plan)!, TODAY);

    // Base = 20 km (last completed week) → this-week target ≈ 20 × 1.1 = 22.
    expect(card.thisWeek.targetVolumeKm).toBeCloseTo(22, 0);
    // This week's actual volume = 12 + 8 = 20 km.
    expect(card.actualVolumeKm).toBe(20);
    expect(card.sessionsThisWeek).toBe(2);
    expect(card.remainingKm).toBeCloseTo(2, 0);
  });

  it("detects the long session via the Strava label, not the raw longest run", () => {
    const { profileId, planId } = seedPlanFixture();
    const plan = getEndurancePlan(profileId, planId)!;
    const card = getEndurancePlanCard(profileId, coachedPlan(plan)!, TODAY);
    // The 8 km LABELED long run wins over the 12 km unlabeled run.
    expect(card.actualLongSessionKm).toBe(8);
  });

  it("falls back to the longest-of-week when no session is labeled", () => {
    const profileId = makeProfile("endurance-nolabel");
    addRun(profileId, "2026-06-08", 10);
    addRun(profileId, "2026-06-15", 9);
    addRun(profileId, "2026-06-17", 13); // raw longest this week, unlabeled
    const out = createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 10,
    });
    const plan = getEndurancePlan(profileId, (out as { id: number }).id)!;
    const card = getEndurancePlanCard(profileId, coachedPlan(plan)!, TODAY);
    expect(card.actualLongSessionKm).toBe(13);
  });

  it("flips to a taper before the event, ending on the event week", () => {
    const { profileId, planId } = seedPlanFixture();
    const plan = getEndurancePlan(profileId, planId)!;
    const card = getEndurancePlanCard(profileId, coachedPlan(plan)!, TODAY);
    const taper = card.trajectory.weeks.filter((w) => w.phase === "taper");
    // A 10k tapers for 1 week.
    expect(taper.length).toBe(1);
    expect(card.trajectory.weeks.at(-1)?.phase).toBe("event");
    expect(card.trajectory.feasible).toBe(true);
  });
});

describe("buildEndurancePlanFindings — coaching-tier long-session nudge (#839)", () => {
  it("emits a discipline-keyed finding when the long session isn't logged yet", () => {
    const profileId = makeProfile("endurance-finding");
    // Base week + this week WITHOUT a long-enough session, so the long session is due.
    addRun(profileId, "2026-06-08", 20);
    addRun(profileId, "2026-06-15", 3);
    createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 10,
    });
    const findings = buildEndurancePlanFindings(profileId, TODAY);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(enduranceLongSessionKey("run"));
    expect(findings[0].domain).toBe("endurance");
    expect(findings[0].tone).toBe("info");
  });

  it("does not fire once this week's long session is logged", () => {
    const profileId = makeProfile("endurance-done");
    addRun(profileId, "2026-06-08", 20);
    // A big labeled long run this week satisfies the scheduled long session.
    addRun(profileId, "2026-06-15", 12, "long run");
    createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 10,
    });
    expect(buildEndurancePlanFindings(profileId, TODAY)).toHaveLength(0);
  });

  it("the illness pause holds the plan-aware arm (#837)", () => {
    const { profileId } = seedPlanFixture();
    // The arm is present normally…
    expect(getEnduranceArm(profileId, TODAY, false)).not.toBeNull();
    // …and held during an open illness episode.
    expect(getEnduranceArm(profileId, TODAY, true)).toBeNull();
  });

  it("only surfaces active plans with a future event date", () => {
    const profileId = makeProfile("endurance-past");
    addRun(profileId, "2026-06-08", 20);
    createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-01-01", // already past
      targetDistanceKm: 10,
    });
    expect(getEndurancePlanCards(profileId, TODAY)).toHaveLength(0);
  });
});

describe("endurance plan lifecycle cores (#839)", () => {
  it("enforces one active plan per discipline", () => {
    const profileId = makeProfile("endurance-oneactive");
    const first = createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 10,
    });
    expect(first.kind).toBe("ok");
    const dup = createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-11-05",
      targetDistanceKm: 21.1,
    });
    expect(dup.kind).toBe("duplicate");
    // A DIFFERENT discipline is allowed.
    const ride = createEndurancePlanCore(profileId, {
      discipline: "ride",
      eventDate: "2026-11-05",
      targetDistanceKm: 100,
    });
    expect(ride.kind).toBe("ok");
    expect(getActiveEndurancePlans(profileId)).toHaveLength(2);
  });

  it("completing a plan records a timeline milestone; deleting cleans it up", () => {
    const profileId = makeProfile("endurance-complete");
    const out = createEndurancePlanCore(profileId, {
      eventName: "Marathon Day",
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 42.2,
    });
    const id = (out as { id: number }).id;
    setEndurancePlanStatusCore(profileId, id, "completed", "2026-10-05");
    expect(getEndurancePlan(profileId, id)!.status).toBe("completed");
    const ms = db
      .prepare(
        "SELECT title, kind FROM milestones WHERE profile_id = ? AND key = ?"
      )
      .get(profileId, `endurance-plan:${id}`) as
      { title: string; kind: string } | undefined;
    expect(ms?.kind).toBe("endurance");
    expect(ms?.title).toMatch(/Marathon Day/);

    // Deleting the plan clears its milestone (row-ops side-state).
    deleteEndurancePlanCore(profileId, id);
    const after = db
      .prepare(
        "SELECT COUNT(*) AS n FROM milestones WHERE profile_id = ? AND key = ?"
      )
      .get(profileId, `endurance-plan:${id}`) as { n: number };
    expect(after.n).toBe(0);
  });

  it("frees the discipline once the active plan is completed", () => {
    const profileId = makeProfile("endurance-free");
    const a = createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2026-10-05",
      targetDistanceKm: 10,
    });
    setEndurancePlanStatusCore(
      profileId,
      (a as { id: number }).id,
      "completed",
      "2026-10-05"
    );
    // A new active run plan is now allowed.
    const b = createEndurancePlanCore(profileId, {
      discipline: "run",
      eventDate: "2027-04-05",
      targetDistanceKm: 21.1,
    });
    expect(b.kind).toBe("ok");
  });
});

// ── #3285: the same store now holds events with no cardio arm ───────────────────

describe("events with no cardio pair (#3285)", () => {
  it("creates a lifting meet from kind + name + date alone", () => {
    const profileId = makeProfile("events-meet");
    const out = createEndurancePlanCore(profileId, {
      kind: "meet",
      eventName: "County Powerlifting Meet",
      eventDate: "2026-10-05",
    });
    expect(out.kind).toBe("ok");
    const plan = getEndurancePlan(profileId, (out as { id: number }).id)!;
    expect(plan.kind).toBe("meet");
    expect(plan.discipline).toBeNull();
    expect(plan.targetDistanceKm).toBeNull();
    expect(coachedPlan(plan)).toBeNull();

    // It is a real event on Training Overview…
    const events = getEnduranceEvents(profileId, "2026-06-15");
    expect(events.map((e) => [e.plan.id, e.card])).toEqual([[plan.id, null]]);
    // …and invisible to the coaching arm, which needs a trajectory. This is the
    // half that keeps every pre-#3285 consumer byte-identical: they read cards.
    expect(getEndurancePlanCards(profileId, "2026-06-15")).toEqual([]);
    expect(getEnduranceArm(profileId, "2026-06-15")).toBeNull();
  });

  it("lets many active no-discipline events coexist", () => {
    // The one-active-per-discipline rule is about a cardio discipline. A household
    // with a meet, a tournament and a club open on the calendar is not a duplicate.
    const profileId = makeProfile("events-many");
    for (const [kind, name] of [
      ["meet", "County Meet"],
      ["tournament", "Club Open"],
      ["competition", "Winter Classic"],
    ] as const) {
      expect(
        createEndurancePlanCore(profileId, {
          kind,
          eventName: name,
          eventDate: "2026-10-05",
        }).kind
      ).toBe("ok");
    }
    expect(getActiveEndurancePlans(profileId)).toHaveLength(3);
  });

  // The cardio pair is validated AS A PAIR: half of it is refused rather than
  // half-stored, so `coachedPlan` never has to decide what a half-pair meant.
  it.each([
    ["discipline with no distance", { discipline: "run" as const }],
    ["distance with no discipline", { targetDistanceKm: 10 }],
  ])("refuses %s", (_label, half) => {
    const profileId = makeProfile(`events-half-${_label.slice(0, 8)}`);
    expect(
      createEndurancePlanCore(profileId, {
        kind: "race",
        eventDate: "2026-10-05",
        ...half,
      }).kind
    ).toBe("invalid");
    expect(getActiveEndurancePlans(profileId)).toHaveLength(0);
  });

  it.each([
    ["absent", undefined, "race"],
    ["blank", "   ", "race"],
    ["cased and padded", "  Time Trial ", "time trial"],
  ])("stores a %s kind as %s", (_label, given, stored) => {
    const profileId = makeProfile(`events-kind-${stored.slice(0, 6)}`);
    const out = createEndurancePlanCore(profileId, {
      kind: given,
      eventName: "Kind Test",
      eventDate: "2026-10-05",
    });
    expect(getEndurancePlan(profileId, (out as { id: number }).id)!.kind).toBe(
      stored
    );
  });

  it("titles a completed meet's milestone by its name, not a cardio fallback", () => {
    const profileId = makeProfile("events-meet-complete");
    const out = createEndurancePlanCore(profileId, {
      kind: "meet",
      eventName: "County Meet",
      eventDate: "2026-10-05",
    });
    const id = (out as { id: number }).id;
    setEndurancePlanStatusCore(profileId, id, "completed", "2026-10-05");
    const ms = db
      .prepare("SELECT title FROM milestones WHERE profile_id = ? AND key = ?")
      .get(profileId, `endurance-plan:${id}`) as { title: string } | undefined;
    expect(ms?.title).toBe("Event completed: County Meet");
  });
});

// ── Events link their activities (#3285 item 2) ─────────────────────────────────
//
// `activities.endurance_plan_id` is the result link. Every row-level fact the issue
// asks for is pinned here: the FK shape, the manual link's day rule and profile
// scope, the Strava "race" auto-link and its refusals, what a plan delete does to
// its activities, and that a merge and an undo carry the link the way they carry
// the gear link.

const RACE_DAY = "2026-06-14";

function linkOf(activityId: number): number | null {
  return (
    db
      .prepare("SELECT endurance_plan_id AS p FROM activities WHERE id = ?")
      .get(activityId) as { p: number | null }
  ).p;
}

// The row's whole event decision: which event it is the result of, and whether a
// PERSON put it there (or took it away). The two columns are read together because
// only together do they say which decision it was.
function decisionOf(activityId: number): {
  plan: number | null;
  optout: number;
} {
  return db
    .prepare(
      `SELECT endurance_plan_id AS plan, endurance_link_optout AS optout
         FROM activities WHERE id = ?`
    )
    .get(activityId) as { plan: number | null; optout: number };
}

function rowOf(activityId: number): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM activities WHERE id = ?")
    .get(activityId) as Record<string, unknown>;
}

function lastRunId(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId) as { id: number }
  ).id;
}

function raceDayPlan(
  profileId: number,
  input: Partial<Parameters<typeof createEndurancePlanCore>[1]> = {}
): number {
  const out = createEndurancePlanCore(profileId, {
    eventName: "Harbor 10k",
    discipline: "run",
    eventDate: RACE_DAY,
    targetDistanceKm: 10,
    ...input,
  });
  expect(out.kind).toBe("ok");
  return (out as { id: number }).id;
}

describe("events link their activities (#3285 item 2)", () => {
  it("activities.endurance_plan_id is a SET NULL foreign key onto endurance_plans", () => {
    const fk = (
      db.prepare("PRAGMA foreign_key_list(activities)").all() as {
        table: string;
        from: string;
        on_delete: string;
      }[]
    ).find((f) => f.from === "endurance_plan_id");
    expect(fk).toMatchObject({
      table: "endurance_plans",
      on_delete: "SET NULL",
    });
  });

  it("links a same-day activity by hand, refuses another day's and another profile's, and unlinks", () => {
    const profileId = makeProfile("event-link");
    const otherProfile = makeProfile("event-link-other");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10.2);
    const onDay = lastRunId(profileId);
    addRun(profileId, "2026-06-13", 3);
    const dayBefore = lastRunId(profileId);
    addRun(otherProfile, RACE_DAY, 10);
    const theirs = lastRunId(otherProfile);

    expect(linkEventActivityCore(profileId, planId, onDay)).toBe(true);
    expect(linkEventActivityCore(profileId, planId, dayBefore)).toBe(false);
    expect(linkEventActivityCore(profileId, planId, theirs)).toBe(false);
    expect(linkEventActivityCore(otherProfile, planId, theirs)).toBe(false);
    expect([linkOf(onDay), linkOf(dayBefore), linkOf(theirs)]).toEqual([
      planId,
      null,
      null,
    ]);

    // Unlink is profile-scoped too, and says whether it did anything.
    expect(unlinkEventActivityCore(otherProfile, onDay)).toBe(false);
    expect(unlinkEventActivityCore(profileId, onDay)).toBe(true);
    expect(unlinkEventActivityCore(profileId, onDay)).toBe(false);
    expect(linkOf(onDay)).toBeNull();
  });

  // The auto-link rule, as a table. Each row seeds ONE activity and asks whether the
  // profile's race-day 10k run plan claims it; the plan is the same in every case
  // except where the case names its own.
  it.each([
    [
      "a race-labelled run on the day",
      "Morning Run",
      "race",
      RACE_DAY,
      {},
      true,
    ],
    ["an unlabelled run on the day", "Morning Run", null, RACE_DAY, {}, false],
    ["a long-run label", "Morning Run", "long run", RACE_DAY, {}, false],
    ["a race the day before", "Morning Run", "race", "2026-06-13", {}, false],
    [
      "a race in another discipline",
      "Evening Ride",
      "race",
      RACE_DAY,
      {},
      false,
    ],
    [
      "a race with no discipline in its name",
      "Workout",
      "race",
      RACE_DAY,
      {},
      false,
    ],
    [
      "a race on a meet's day (no discipline)",
      "Morning Run",
      "race",
      RACE_DAY,
      { kind: "meet", discipline: null, targetDistanceKm: null },
      false,
    ],
  ] as const)(
    "auto-link: %s → %s",
    (_label, title, workoutType, date, planInput, expected) => {
      const profileId = makeProfile(`auto-${title}-${workoutType}-${date}`);
      const planId = raceDayPlan(profileId, planInput);
      addRun(profileId, date, 10, workoutType, title);
      const id = lastRunId(profileId);
      expect(linkRaceActivityCore(profileId, id)).toBe(expected);
      expect(linkOf(id)).toBe(expected ? planId : null);
    }
  );

  it("auto-link keeps a hand-made link, skips an abandoned event, and still claims a completed one", () => {
    const profileId = makeProfile("auto-status");
    const planId = raceDayPlan(profileId);
    const otherId = raceDayPlan(profileId, {
      eventName: "Charity Mile",
      discipline: null,
      targetDistanceKm: null,
    });
    addRun(profileId, RACE_DAY, 10, "race");
    const raced = lastRunId(profileId);
    // Already linked by hand to the mile → the race label does not move it.
    expect(linkEventActivityCore(profileId, otherId, raced)).toBe(true);
    expect(linkRaceActivityCore(profileId, raced)).toBe(false);
    expect(linkOf(raced)).toBe(otherId);

    // A SECOND race-labelled session for the status cases, never touched by hand:
    // unlinking `raced` would opt it out of the auto-link for good, which is its own
    // case below.
    addRun(profileId, RACE_DAY, 10, "race");
    const fresh = lastRunId(profileId);
    setEndurancePlanStatusCore(profileId, planId, "abandoned", RACE_DAY);
    expect(linkRaceActivityCore(profileId, fresh)).toBe(false);
    setEndurancePlanStatusCore(profileId, planId, "completed", RACE_DAY);
    expect(linkRaceActivityCore(profileId, fresh)).toBe(true);
    expect(linkOf(fresh)).toBe(planId);
  });

  it("the integration upsert auto-links on insert and on the re-sync that first labels the race", () => {
    const profileId = makeProfile("auto-upsert");
    const planId = raceDayPlan(profileId);
    const row = (workoutType: string | null) => ({
      external_id: "strava:race-10k",
      date: RACE_DAY,
      type: "cardio" as const,
      title: "Harbor 10k",
      duration_min: 44,
      distance_km: toKm(10.1, "km"),
      start_time: "09:00",
      end_time: "09:44",
      workout_type: workoutType,
    });
    upsertActivities(profileId, [row(null)], "strava");
    const id = lastRunId(profileId);
    expect(linkOf(id)).toBeNull();
    upsertActivities(profileId, [row("race")], "strava");
    expect(lastRunId(profileId)).toBe(id); // updated in place, not re-inserted
    expect(linkOf(id)).toBe(planId);
  });

  it("deleting the event unlinks its activities and keeps them", () => {
    const profileId = makeProfile("event-delete");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race");
    const id = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, id)).toBe(true);
    expect(deleteEndurancePlanCore(profileId, planId)).toBe(true);
    expect(linkOf(id)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM activities WHERE id = ?").get(id)
    ).toEqual({ n: 1 });
  });

  it("a merge folds the drop's link onto a keeper with none, and undo takes it back", () => {
    const profileId = makeProfile("event-merge");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, null, "Harbor 10k (watch)");
    const keepId = lastRunId(profileId);
    addRun(profileId, RACE_DAY, 10.1, "race", "Harbor 10k");
    const dropId = lastRunId(profileId);
    linkRaceActivityCore(profileId, dropId);
    const rowOf = (id: number) =>
      db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    const keep = rowOf(keepId);
    const drop = rowOf(dropId);

    writeActivityFold(profileId, keepId, keep, [drop]);
    expect(linkOf(keepId)).toBe(planId);

    const undoId = captureDelete("activity", profileId, dropId, {
      keeperId: keepId,
      mergeId: "merge-1",
      domain: "activity",
      signature: `${keepId}|${dropId}`,
      keeperBefore: snapshotKeeperFold(keep),
      movedSetIds: [],
      movedRouteId: null,
      movedTelemetryIds: [],
      movedLapIds: [],
      movedSegmentEffortIds: [],
    })!;
    expect(restoreDeletedRow(profileId, undoId)).toBe(true);
    // The keeper is back to unlinked; the restored drop carries the link.
    expect(linkOf(keepId)).toBeNull();
    expect(linkOf(lastRunId(profileId))).toBe(planId);
  });

  it("a deleted activity restores with its link, or unlinked once the event is gone", () => {
    const profileId = makeProfile("event-undo");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race");
    const first = lastRunId(profileId);
    linkRaceActivityCore(profileId, first);
    const undoFirst = captureDelete("activity", profileId, first)!;
    expect(restoreDeletedRow(profileId, undoFirst)).toBe(true);
    expect(linkOf(lastRunId(profileId))).toBe(planId);

    const undoSecond = captureDelete(
      "activity",
      profileId,
      lastRunId(profileId)
    )!;
    deleteEndurancePlanCore(profileId, planId);
    // The captured row still names the plan; restore nulls the dead link rather
    // than failing the whole undo on the FK.
    expect(restoreDeletedRow(profileId, undoSecond)).toBe(true);
    expect(linkOf(lastRunId(profileId))).toBeNull();
  });

  // #3056 / #3189–#3191 — the draft census reaches this list too. `getEventDay` is
  // one tap from making a row the event's RESULT, so a create-at-start husk must not
  // be offered here any more than it is counted anywhere else. The control is the
  // established surface: `getWorkoutActivityDays` already hides the same row.
  it("does not offer a create-at-start draft, and still offers the session that logged something", () => {
    const profileId = makeProfile("event-draft");
    const planId = raceDayPlan(profileId);
    // Exactly as create-at-start writes it: dated, typed, titled, started, nothing else.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time)
       VALUES (?, ?, 'strength', 'Workout', '09:00')`
    ).run(profileId, RACE_DAY);
    const husk = lastRunId(profileId);

    expect(getWorkoutActivityDays(profileId, RACE_DAY, RACE_DAY)).toEqual([]);
    expect(getEventDay(profileId, planId)!.activities).toEqual([]);

    // The positive control: the SAME row, once it has logged a set, is an entry.
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Squat', 1, 60, 5)`
    ).run(husk);
    expect(
      getEventDay(profileId, planId)!.activities.map((a) => a.title)
    ).toEqual(["Workout"]);
  });

  // The same-day steal (#3285 item 2): two events, one day. The activity model allows
  // one event per activity, so linking here MOVES the result — the row is offered
  // LAST, behind the day's genuinely free sessions, and says where it already belongs.
  it("offers another event's result last, marked, behind the free sessions", () => {
    const profileId = makeProfile("event-steal");
    const mine = raceDayPlan(profileId);
    const theirs = raceDayPlan(profileId, {
      eventName: "Charity Mile",
      discipline: null,
      targetDistanceKm: null,
    });
    addRun(profileId, RACE_DAY, 10.1, "race", "ZZZ Other event run");
    const taken = lastRunId(profileId);
    addRun(profileId, RACE_DAY, 3, null, "AAA Shakeout");
    addRun(profileId, RACE_DAY, 2, null, "MMM Cooldown");
    expect(linkEventActivityCore(profileId, theirs, taken)).toBe(true);

    expect(
      getEventDay(profileId, mine)!.activities.map((a) => [
        a.title,
        a.linked,
        a.linkedElsewhere,
      ])
    ).toEqual([
      ["AAA Shakeout", false, false],
      ["MMM Cooldown", false, false],
      ["ZZZ Other event run", false, true],
    ]);
  });

  it("the event page reads the day linked-first, plus a linked session the day edit left behind", () => {
    const profileId = makeProfile("event-day");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 3, null, "Shakeout");
    addRun(profileId, RACE_DAY, 10.1, "race", "Harbor 10k");
    const raced = lastRunId(profileId);
    addRun(profileId, "2026-06-13", 2, null, "Strides");
    const eve = lastRunId(profileId);
    linkRaceActivityCore(profileId, raced);
    // Linked on its own day, then the date moved: the link is the fact, the date
    // is the search key for the rest.
    db.prepare("UPDATE activities SET endurance_plan_id = ? WHERE id = ?").run(
      planId,
      eve
    );
    const day = getEventDay(profileId, planId)!;
    expect(day.plan.id).toBe(planId);
    expect(
      day.activities.map((a) => [a.title, a.date, a.linked, a.workoutType])
    ).toEqual([
      ["Strides", "2026-06-13", true, null],
      ["Harbor 10k", RACE_DAY, true, "race"],
      ["Shakeout", RACE_DAY, false, null],
    ]);
    expect(getEventDay(makeProfile("event-day-other"), planId)).toBeUndefined();
  });

  // An explicit unlink is a person's decision, and a sync must not undo it. The
  // auto-link re-runs after EVERY value-changing update, so without the remembered
  // opt-out a title fix on Strava re-attaches the session the person detached.
  it("a re-sync never re-links a session the person unlinked, and a hand link takes it back", () => {
    const profileId = makeProfile("unlink-sticks");
    const planId = raceDayPlan(profileId);
    const row = (title: string) => ({
      external_id: "strava:race-10k",
      date: RACE_DAY,
      type: "cardio" as const,
      title,
      duration_min: 44,
      distance_km: toKm(10.1, "km"),
      start_time: "09:00",
      end_time: "09:44",
      workout_type: "race",
    });
    upsertActivities(profileId, [row("Harbor 10k")], "strava");
    const id = lastRunId(profileId);
    expect(linkOf(id)).toBe(planId);

    expect(unlinkEventActivityCore(profileId, id)).toBe(true);
    // The row is NOT edit-locked: detaching it from an event must not also stop the
    // provider correcting its values (that is the #133 lock, and this is not it).
    expect(
      db.prepare("SELECT edited FROM activities WHERE id = ?").get(id)
    ).toMatchObject({ edited: 0 });

    // A value-changing re-sync — the title fix — updates the row and leaves the
    // decision standing.
    const counts = upsertActivities(
      profileId,
      [row("Harbor 10k ⭐")],
      "strava"
    );
    expect(counts.updated).toBe(1);
    expect(linkOf(id)).toBeNull();
    // Neither does the core itself, asked directly.
    expect(linkRaceActivityCore(profileId, id)).toBe(false);

    // Changing their mind REPLACES one decision with another — it does not hand the
    // session back to the sync. A hand link sticks, and unlinking again still refuses.
    expect(linkEventActivityCore(profileId, planId, id)).toBe(true);
    expect(unlinkEventActivityCore(profileId, id)).toBe(true);
    expect(linkRaceActivityCore(profileId, id)).toBe(false);
  });

  // The explicit UPDATE in deleteEndurancePlanCore, not the FK. With foreign_keys ON
  // the ON DELETE SET NULL satisfies the assertion on its own, so the pragma is turned
  // OFF here — the posture the migration runner's connection actually has.
  it("unlinks the event's activities with foreign keys OFF, not only via the FK", () => {
    const profileId = makeProfile("event-delete-nofk");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race");
    const id = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, id)).toBe(true);

    db.pragma("foreign_keys = OFF");
    try {
      expect(deleteEndurancePlanCore(profileId, planId)).toBe(true);
    } finally {
      db.pragma("foreign_keys = ON");
    }
    expect(linkOf(id)).toBeNull();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  // ── The detach has to survive the paths that MOVE the row, not just the one that
  //    sets the flag (#3285 item 2). `endurance_link_optout` is the person's decision
  //    about this session; a merge deletes rows, an event delete drops links, and an
  //    undo puts old columns back. None of them may hand the session back to the sync.

  // The unattended reproduction, through real entry points only: two connected
  // sources, one detach, and NOTHING else the person does. autoMergeActivityDuplicates
  // runs from strava-sync and health-connect-ingest after every ingest that inserted a
  // row, and it DELETES the row that carries the decision.
  it("the sync's own auto-merge cannot re-attach a session the person detached", () => {
    const profileId = makeProfile("merge-reattach");
    const planId = raceDayPlan(profileId);
    const row = (externalId: string) => ({
      external_id: externalId,
      date: RACE_DAY,
      type: "cardio" as const,
      title: "Harbor 10k",
      duration_min: 44,
      distance_km: toKm(10.1, "km"),
      start_time: "09:00",
      end_time: "09:44",
      workout_type: "race",
    });

    upsertActivities(profileId, [row("strava:race")], "strava");
    const stravaId = lastRunId(profileId);
    expect(linkOf(stravaId)).toBe(planId);
    expect(unlinkEventActivityCore(profileId, stravaId)).toBe(true);

    // A second source ingests the same race the next morning and auto-links its own
    // copy — that row carries no decision, so the auto-link is right to take it.
    upsertActivities(profileId, [row("hc:race")], "health-connect");
    const hcId = lastRunId(profileId);
    expect(linkOf(hcId)).toBe(planId);

    // The sync collapses the pair with nobody watching.
    expect(autoMergeActivityDuplicates(profileId)).toBe(1);
    const survivors = db
      .prepare("SELECT id FROM activities WHERE profile_id = ?")
      .all(profileId) as { id: number }[];
    expect(survivors).toHaveLength(1);
    // One session, one decision: detached, and remembered.
    expect(decisionOf(survivors[0].id)).toEqual({ plan: null, optout: 1 });
    expect(
      getEventDay(profileId, planId)?.activities.filter((a) => a.linked)
    ).toEqual([]);
  });

  // Direction 1 of the fold: the keeper carries the decision. The drop's link must not
  // gap-fill onto it, and the flag must not be zeroed by the fold's UPDATE.
  it("a merge folds no link onto a keeper the person detached, and keeps the memory", () => {
    const profileId = makeProfile("merge-keeper-detached");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race", "Harbor 10k (watch)");
    const keepId = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, keepId)).toBe(true);
    expect(unlinkEventActivityCore(profileId, keepId)).toBe(true);

    addRun(profileId, RACE_DAY, 10.1, "race", "Harbor 10k");
    const dropId = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, dropId)).toBe(true);
    expect(linkOf(dropId)).toBe(planId);

    writeActivityFold(profileId, keepId, rowOf(keepId), [rowOf(dropId)]);
    expect(decisionOf(keepId)).toEqual({ plan: null, optout: 1 });
  });

  // Direction 2: the decision is on the row being DESTROYED. The keeper is the
  // second source's auto-linked copy — richer, so it wins — and folding the detached
  // row into it must move the detach across, link and all.
  it("a merge carries a dropped row's detach onto the keeper, link and all", () => {
    const profileId = makeProfile("merge-drop-detached");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race", "Harbor 10k");
    const dropId = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, dropId)).toBe(true);
    expect(unlinkEventActivityCore(profileId, dropId)).toBe(true);

    addRun(profileId, RACE_DAY, 10.1, "race", "Harbor 10k (phone)");
    const keepId = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, keepId)).toBe(true);
    expect(decisionOf(keepId)).toEqual({ plan: planId, optout: 0 });

    writeActivityFold(profileId, keepId, rowOf(keepId), [rowOf(dropId)]);
    expect(decisionOf(keepId)).toEqual({ plan: null, optout: 1 });
  });

  // The same rule read the other way: a HAND link on the dropped row is a decision
  // too, so it survives the fold rather than being lost with the row.
  it("a merge carries a dropped row's hand-made link onto an undecided keeper", () => {
    const profileId = makeProfile("merge-drop-linked");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, null, "Harbor 10k (watch)");
    const keepId = lastRunId(profileId);
    addRun(profileId, RACE_DAY, 10.1, null, "Harbor 10k");
    const dropId = lastRunId(profileId);
    expect(linkEventActivityCore(profileId, planId, dropId)).toBe(true);

    writeActivityFold(profileId, keepId, rowOf(keepId), [rowOf(dropId)]);
    expect(decisionOf(keepId)).toEqual({ plan: planId, optout: 1 });
  });

  // Undoing a merge puts the keeper's pre-merge columns back. A detach made AFTER the
  // merge is newer than any of them and must outlive the undo.
  it("undoing a merge does not hand back a link the person removed after it", () => {
    const profileId = makeProfile("merge-undo-detach");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race", "Harbor 10k");
    const keepId = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, keepId)).toBe(true);
    expect(linkOf(keepId)).toBe(planId);
    addRun(profileId, RACE_DAY, 10.1, null, "Harbor 10k (phone)");
    const dropId = lastRunId(profileId);

    const keep = rowOf(keepId);
    writeActivityFold(profileId, keepId, keep, [rowOf(dropId)]);
    const undoId = captureDelete("activity", profileId, dropId, {
      keeperId: keepId,
      mergeId: "merge-undo-detach",
      domain: "activity",
      signature: `${keepId}|${dropId}`,
      keeperBefore: snapshotKeeperFold(keep),
      movedSetIds: [],
      movedRouteId: null,
      movedTelemetryIds: [],
      movedLapIds: [],
      movedSegmentEffortIds: [],
    })!;

    expect(unlinkEventActivityCore(profileId, keepId)).toBe(true);
    expect(restoreDeletedRow(profileId, undoId)).toBe(true);
    expect(decisionOf(keepId)).toEqual({ plan: null, optout: 1 });
    expect(linkRaceActivityCore(profileId, keepId)).toBe(false);
  });

  // Aim point 1: the sequence that made a cleared flag dangerous. Detach from A, take
  // the session to B by hand, then delete B — the row is free again, and the next sync
  // would re-attach it to the very event it was detached from. A hand link SETS the
  // flag, so there is nothing left to launder.
  it("moving a session to another event and then deleting that event leaves it alone", () => {
    const profileId = makeProfile("link-launder");
    const planA = raceDayPlan(profileId);
    const planB = raceDayPlan(profileId, {
      eventName: "Harbor Fun Run",
      discipline: null,
      targetDistanceKm: null,
    });
    addRun(profileId, RACE_DAY, 10, "race", "Harbor 10k");
    const id = lastRunId(profileId);
    expect(linkRaceActivityCore(profileId, id)).toBe(true);
    expect(linkOf(id)).toBe(planA);

    expect(unlinkEventActivityCore(profileId, id)).toBe(true);
    expect(linkEventActivityCore(profileId, planB, id)).toBe(true);
    expect(deleteEndurancePlanCore(profileId, planB)).toBe(true);

    expect(decisionOf(id)).toEqual({ plan: null, optout: 1 });
    expect(linkRaceActivityCore(profileId, id)).toBe(false);
  });

  // The same laundering through the raw FK — `ON DELETE SET NULL` fires without
  // deleteEndurancePlanCore ever running, so the flag has to be what holds.
  it("the FK's own SET NULL leaves the decision standing", () => {
    const profileId = makeProfile("link-fk-launder");
    const planId = raceDayPlan(profileId);
    addRun(profileId, RACE_DAY, 10, "race", "Harbor 10k");
    const id = lastRunId(profileId);
    expect(linkEventActivityCore(profileId, planId, id)).toBe(true);

    db.prepare("DELETE FROM endurance_plans WHERE id = ?").run(planId);
    expect(decisionOf(id)).toEqual({ plan: null, optout: 1 });
    expect(linkRaceActivityCore(profileId, id)).toBe(false);
  });
});
