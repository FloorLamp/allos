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
} from "@/lib/queries";
import { buildEndurancePlanFindings } from "@/lib/rule-findings";
import {
  createEndurancePlanCore,
  getActiveEndurancePlans,
  getEndurancePlan,
  setEndurancePlanStatusCore,
  deleteEndurancePlanCore,
} from "@/lib/endurance-plans";
import { enduranceLongSessionKey } from "@/lib/endurance-plan";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name).lastInsertRowid
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
    const card = getEndurancePlanCard(profileId, plan, TODAY);

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
    const card = getEndurancePlanCard(profileId, plan, TODAY);
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
    const card = getEndurancePlanCard(profileId, plan, TODAY);
    expect(card.actualLongSessionKm).toBe(13);
  });

  it("flips to a taper before the event, ending on the event week", () => {
    const { profileId, planId } = seedPlanFixture();
    const plan = getEndurancePlan(profileId, planId)!;
    const card = getEndurancePlanCard(profileId, plan, TODAY);
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
      | { title: string; kind: string }
      | undefined;
    expect(ms?.kind).toBe("endurance");
    expect(ms?.title).toMatch(/Marathon Day/);

    // Deleting the plan clears its milestone (row-ops side-state).
    deleteEndurancePlanCore(profileId, id);
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM milestones WHERE profile_id = ? AND key = ?")
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
