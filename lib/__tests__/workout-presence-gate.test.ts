// Pure-tier: the workout-reminder presence gates (issue #981). Every fixture drives
// the gate through the REAL presence derivation (computeWorkoutPresence) so the two
// can't drift, and pins the acceptance matrix — including the "deliberately NOT gated"
// cases nobody should "fix" (a walk that credits nothing still fires; a generic finish
// never holds) — plus the finished-window boundary on both sides of its documented
// constant.

import { describe, it, expect } from "vitest";
import {
  computeWorkoutPresence,
  FINISHED_WINDOW_MIN,
  ACTIVE_MAX_QUIET_MIN,
  STALE_MIN,
  type PresenceActivityRow,
} from "@/lib/workout-presence";
import {
  workoutPresenceGate,
  finishCreditsTrackedScope,
  type FinishedActivityCredit,
  type TrackedScope,
} from "@/lib/workout-presence-gate";
import { utcSqlString } from "@/lib/date";

const TZ = "UTC";
const TODAY = "2026-07-17";
// A fixed "now" at 14:00 UTC on TODAY — every fixture positions its start/end/touch
// relative to this so the derivation is deterministic.
const NOW = new Date("2026-07-17T14:00:00Z");

function minsAgo(mins: number): Date {
  return new Date(NOW.getTime() - mins * 60_000);
}

// A live (manual, un-ended) session: started this morning, draft last touched
// `quietMin` ago. source null ⇒ eligible to read as `active`.
function liveRow(quietMin: number): PresenceActivityRow {
  return {
    id: 1,
    type: "strength",
    title: "Push day",
    date: TODAY,
    start_time: "13:00",
    end_time: null,
    duration_min: null,
    created_at: utcSqlString(minsAgo(quietMin + 30)),
    updated_at: utcSqlString(minsAgo(quietMin)),
    source: null,
  };
}

// A finished activity whose end instant is `ageMin` before NOW.
function finishedRow(
  ageMin: number,
  over: Partial<PresenceActivityRow> = {}
): PresenceActivityRow {
  const end = minsAgo(ageMin);
  const hh = String(end.getUTCHours()).padStart(2, "0");
  const mm = String(end.getUTCMinutes()).padStart(2, "0");
  return {
    id: 2,
    type: "cardio",
    title: "Dog walk",
    date: TODAY,
    start_time: "13:00",
    end_time: `${hh}:${mm}`,
    duration_min: null,
    created_at: utcSqlString(minsAgo(ageMin + 30)),
    updated_at: utcSqlString(minsAgo(ageMin + 30)),
    source: null,
    ...over,
  };
}

function presence(rows: PresenceActivityRow[]) {
  return computeWorkoutPresence(rows, NOW, TZ, TODAY);
}

// A cardio ("walk") credit footprint.
const WALK_CREDIT: FinishedActivityCredit = {
  type: "cardio",
  componentTypes: [],
  regions: [],
  mobilityRegions: [],
};

const WALK_TARGET: TrackedScope = { scope_kind: "type", scope_value: "cardio" };
const STRENGTH_TARGET: TrackedScope = {
  scope_kind: "region",
  scope_value: "Chest",
};

describe("workoutPresenceGate — gate 1 (mid-workout HOLD)", () => {
  it("active session ⇒ hold", () => {
    const p = presence([liveRow(5)]);
    expect(p.state).toBe("active");
    expect(workoutPresenceGate(p, null, [STRENGTH_TARGET])).toBe("hold");
  });

  it("active + stale (draft quiet past STALE_MIN, still under the cap) ⇒ still hold", () => {
    const p = presence([liveRow(STALE_MIN + 5)]);
    expect(p.state).toBe("active");
    expect(p.stale).toBe(true);
    expect(workoutPresenceGate(p, null, [STRENGTH_TARGET])).toBe("hold");
  });

  it("active-with-decayed-liveness (quiet past the cap) ⇒ NO hold — stale-suggest's jurisdiction, not the reminder's", () => {
    const p = presence([liveRow(ACTIVE_MAX_QUIET_MIN + 5)]);
    expect(p.state).toBe("idle");
    expect(workoutPresenceGate(p, null, [STRENGTH_TARGET])).toBe("fire");
  });

  it("a completed manual log never holds (it's finished/idle, never active)", () => {
    // Ended just now, credits nothing tracked ⇒ not a hold and not a skip → fire.
    const done = finishedRow(2, { type: "strength", title: "Push day" });
    const p = presence([done]);
    expect(p.state).toBe("finished");
    const gate = workoutPresenceGate(
      p,
      { type: "strength", componentTypes: [], regions: [], mobilityRegions: [] },
      [WALK_TARGET] // no matching scope
    );
    expect(gate).not.toBe("hold");
    expect(gate).toBe("fire");
  });
});

describe("workoutPresenceGate — gate 2 (credit-bearing finish SKIP, window-scoped)", () => {
  it("credit-bearing finish inside the window ⇒ skip", () => {
    const p = presence([finishedRow(20)]);
    expect(p.state).toBe("finished");
    expect(workoutPresenceGate(p, WALK_CREDIT, [WALK_TARGET])).toBe("skip");
  });

  it("the SAME finish outside the window ⇒ fire (presence has decayed to idle)", () => {
    const p = presence([finishedRow(FINISHED_WINDOW_MIN + 1)]);
    expect(p.state).toBe("idle");
    // Even with a would-match credit, an idle presence never skips.
    expect(workoutPresenceGate(p, WALK_CREDIT, [WALK_TARGET])).toBe("fire");
  });

  it("walk + NO walking target + behind strength ⇒ FIRE (the walk credits nothing tracked)", () => {
    const p = presence([finishedRow(20)]);
    expect(p.state).toBe("finished");
    expect(workoutPresenceGate(p, WALK_CREDIT, [STRENGTH_TARGET])).toBe("fire");
  });

  it("walk + walking target ⇒ skip THIS attempt", () => {
    const p = presence([finishedRow(20)]);
    expect(
      workoutPresenceGate(p, WALK_CREDIT, [STRENGTH_TARGET, WALK_TARGET])
    ).toBe("skip");
  });

  it("finished window boundary — at the constant is IN (skip), one minute past is OUT (fire)", () => {
    const inside = presence([finishedRow(FINISHED_WINDOW_MIN)]);
    expect(inside.state).toBe("finished");
    expect(workoutPresenceGate(inside, WALK_CREDIT, [WALK_TARGET])).toBe("skip");

    const outside = presence([finishedRow(FINISHED_WINDOW_MIN + 1)]);
    expect(outside.state).toBe("idle");
    expect(workoutPresenceGate(outside, WALK_CREDIT, [WALK_TARGET])).toBe(
      "fire"
    );
  });

  it("idle presence always fires (no live session, no recent finish)", () => {
    const p = presence([]);
    expect(p.state).toBe("idle");
    expect(workoutPresenceGate(p, null, [WALK_TARGET])).toBe("fire");
  });
});

describe("finishCreditsTrackedScope — the scope→credit rules", () => {
  it("type scope matches the activity type or a component type", () => {
    expect(finishCreditsTrackedScope(WALK_CREDIT, [WALK_TARGET])).toBe(true);
    const multi: FinishedActivityCredit = {
      type: "sport",
      componentTypes: ["cardio"],
      regions: [],
      mobilityRegions: [],
    };
    expect(finishCreditsTrackedScope(multi, [WALK_TARGET])).toBe(true);
  });

  it("region scope matches a trained region; group scope matches via the region union", () => {
    const chest: FinishedActivityCredit = {
      type: "strength",
      componentTypes: [],
      regions: ["Chest"],
      mobilityRegions: [],
    };
    expect(finishCreditsTrackedScope(chest, [STRENGTH_TARGET])).toBe(true);
    expect(
      finishCreditsTrackedScope(chest, [
        { scope_kind: "group", scope_value: "Upper" },
      ])
    ).toBe(true);
    expect(
      finishCreditsTrackedScope(chest, [
        { scope_kind: "group", scope_value: "Lower" },
      ])
    ).toBe(false);
  });

  it("mobility_region scope matches a mobilized region only", () => {
    const mob: FinishedActivityCredit = {
      type: "recovery",
      componentTypes: ["recovery"],
      regions: [],
      mobilityRegions: ["Glutes"],
    };
    expect(
      finishCreditsTrackedScope(mob, [
        { scope_kind: "mobility_region", scope_value: "Glutes" },
      ])
    ).toBe(true);
    // A strength `region` target is a SEPARATE dimension (#482 trained ≠ mobilized).
    expect(
      finishCreditsTrackedScope(mob, [
        { scope_kind: "region", scope_value: "Glutes" },
      ])
    ).toBe(false);
  });

  it("food_group (and any non-activity scope) is never credited by a workout finish", () => {
    expect(
      finishCreditsTrackedScope(WALK_CREDIT, [
        { scope_kind: "food_group", scope_value: "vegetables" },
      ])
    ).toBe(false);
  });

  it("no tracked scopes ⇒ nothing to credit", () => {
    expect(finishCreditsTrackedScope(WALK_CREDIT, [])).toBe(false);
  });
});
