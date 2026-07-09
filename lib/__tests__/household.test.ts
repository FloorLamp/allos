import { describe, expect, it } from "vitest";
import {
  goalHighlights,
  goalPct,
  pickNextAppointment,
  supplementAdherenceToday,
  weightTrend,
} from "@/lib/household";
import type { Goal, Supplement } from "@/lib/types";
import type { GoalProgress } from "@/lib/goal-progress";
import type { UpcomingItem } from "@/lib/upcoming";

// Minimal Goal factory (freeform by default), matching goals.test.ts.
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 1,
    title: "Goal",
    description: null,
    category: null,
    target_value: null,
    current_value: null,
    unit: null,
    target_date: null,
    status: "active",
    created_at: "2026-01-01",
    exercise: null,
    metric: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    body_metric: null,
    baseline_value: null,
    archived: 0,
    ...overrides,
  };
}

function supp(overrides: Partial<Supplement> = {}): Supplement {
  return {
    id: 1,
    name: "S",
    notes: null,
    active: 1,
    created_at: "2026-01-01",
    condition: "daily",
    priority: "high",
    brand: null,
    product: null,
    situation: null,
    stack: null,
    critical: 0,
    escalate_after_min: null,
    escalate_chat_id: null,
    quantity_on_hand: null,
    qty_per_dose: 1,
    kind: "supplement",
    prescriber: null,
    pharmacy: null,
    rx_number: null,
    as_needed: 0,
    document_id: null,
    source: null,
    provider_id: null,
    ...overrides,
  };
}

describe("supplementAdherenceToday", () => {
  const ctx = { isWorkoutDay: false, activeSituations: new Set<string>() };

  it("counts due doses and how many are taken", () => {
    const doses = [
      { id: 10, supplement_id: 1 },
      { id: 11, supplement_id: 1 },
      { id: 12, supplement_id: 2 },
    ];
    const byId = new Map([
      [1, supp({ id: 1, condition: "daily" })],
      [2, supp({ id: 2, condition: "daily" })],
    ]);
    const adh = supplementAdherenceToday(doses, byId, ctx, new Set([10, 12]));
    expect(adh).toEqual({ taken: 2, due: 3 });
  });

  it("skips doses whose supplement isn't in the active map", () => {
    const doses = [
      { id: 10, supplement_id: 1 },
      { id: 20, supplement_id: 99 }, // inactive/deleted supplement
    ];
    const byId = new Map([[1, supp({ id: 1 })]]);
    const adh = supplementAdherenceToday(doses, byId, ctx, new Set([10, 20]));
    expect(adh).toEqual({ taken: 1, due: 1 });
  });

  it("excludes doses not due today via isDueOn (rest-day supplement on a workout day)", () => {
    const doses = [
      { id: 10, supplement_id: 1 },
      { id: 11, supplement_id: 2 },
    ];
    const byId = new Map([
      [1, supp({ id: 1, condition: "daily" })],
      [2, supp({ id: 2, condition: "rest_day" })],
    ]);
    const workoutCtx = {
      isWorkoutDay: true,
      activeSituations: new Set<string>(),
    };
    const adh = supplementAdherenceToday(
      doses,
      byId,
      workoutCtx,
      new Set([10, 11])
    );
    // Only the daily dose is due; the rest-day dose is not counted even though
    // it happens to be logged.
    expect(adh).toEqual({ taken: 1, due: 1 });
  });

  it("counts a situational dose only when its situation is active", () => {
    const doses = [{ id: 10, supplement_id: 1 }];
    const byId = new Map([
      [1, supp({ id: 1, condition: "situational", situation: "Travel" })],
    ]);
    expect(supplementAdherenceToday(doses, byId, ctx, new Set())).toEqual({
      taken: 0,
      due: 0,
    });
    const travel = {
      isWorkoutDay: false,
      activeSituations: new Set(["Travel"]),
    };
    expect(
      supplementAdherenceToday(doses, byId, travel, new Set([10]))
    ).toEqual({ taken: 1, due: 1 });
  });
});

describe("weightTrend", () => {
  it("returns null without two readings", () => {
    expect(weightTrend(72, null)).toBeNull();
    expect(weightTrend(null, 72)).toBeNull();
    expect(weightTrend(undefined, undefined)).toBeNull();
  });

  it("reads a rise as up and a drop as down", () => {
    expect(weightTrend(73, 72)).toEqual({ dir: "up", deltaKg: 1 });
    expect(weightTrend(71, 72)).toEqual({ dir: "down", deltaKg: -1 });
  });

  it("treats sub-tolerance movement as flat", () => {
    const t = weightTrend(72.05, 72);
    expect(t?.dir).toBe("flat");
    expect(t?.deltaKg).toBeCloseTo(0.05);
  });

  it("honors a custom tolerance", () => {
    expect(weightTrend(72.5, 72, 1)?.dir).toBe("flat");
    expect(weightTrend(72.5, 72, 0.1)?.dir).toBe("up");
  });
});

describe("goalPct", () => {
  it("uses derived progress for metric/body goals (0 when uncomputed)", () => {
    const g = makeGoal({ exercise: "Bench", metric: "weight" });
    const p: GoalProgress = { current: 80, target: 100, pct: 80, done: false };
    expect(goalPct(g, p)).toBe(80);
    expect(goalPct(g, undefined)).toBe(0);
  });

  it("uses current/target for manual numeric goals, capped at 100", () => {
    expect(goalPct(makeGoal({ target_value: 200, current_value: 50 }))).toBe(
      25
    );
    expect(goalPct(makeGoal({ target_value: 100, current_value: 250 }))).toBe(
      100
    );
  });

  it("returns null for a goal with no numeric basis", () => {
    expect(goalPct(makeGoal())).toBeNull();
  });
});

describe("pickNextAppointment", () => {
  const appt = (id: number, dueDate: string | null): UpcomingItem => ({
    key: `appointment:${id}`,
    domain: "appointment",
    title: `Visit ${id}`,
    href: "/appointments",
    dueDate,
  });

  it("returns null for an empty list", () => {
    expect(pickNextAppointment([])).toBeNull();
  });

  it("picks the soonest by calendar date", () => {
    const chosen = pickNextAppointment([
      appt(1, "2026-07-20"),
      appt(2, "2026-07-11"),
      appt(3, "2026-08-01"),
    ]);
    expect(chosen?.key).toBe("appointment:2");
  });

  it("surfaces a still-scheduled past visit ahead of a future one", () => {
    const chosen = pickNextAppointment([
      appt(1, "2026-07-15"),
      appt(2, "2026-07-01"), // overdue but still scheduled
    ]);
    expect(chosen?.key).toBe("appointment:2");
  });

  it("prefers a dated visit over one missing a due date", () => {
    const chosen = pickNextAppointment([appt(1, null), appt(2, "2026-07-15")]);
    expect(chosen?.key).toBe("appointment:2");
  });
});

describe("goalHighlights", () => {
  it("keeps only active, non-archived goals, capped at the limit", () => {
    const goals = [
      makeGoal({ id: 1, title: "A", target_value: 10, current_value: 5 }),
      makeGoal({ id: 2, title: "B", status: "achieved" }),
      makeGoal({ id: 3, title: "C", archived: 1 }),
      makeGoal({ id: 4, title: "D" }),
      makeGoal({ id: 5, title: "E" }),
    ];
    const hi = goalHighlights(goals, new Map(), 2);
    expect(hi.map((h) => h.title)).toEqual(["A", "D"]);
    expect(hi[0].pct).toBe(50);
    expect(hi[1].pct).toBeNull();
  });
});
