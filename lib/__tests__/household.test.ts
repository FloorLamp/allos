import { describe, expect, it } from "vitest";
import {
  goalHighlights,
  pickNextAppointment,
  supplementAdherenceToday,
  weightTrend,
} from "@/lib/household";
import type { Goal, Supplement } from "@/lib/types";
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
    situation_id: null,
    brand: null,
    product: null,
    situation: null,
    stack: null,
    critical: 0,
    escalate_after_min: null,
    escalate_chat_id: null,
    quantity_on_hand: null,
    qty_per_dose: 1,
    last_fill_size: null,
    kind: "supplement",
    prescriber: null,
    pharmacy: null,
    rx_number: null,
    rx: 0,
    as_needed: 0,
    min_interval_hours: null,
    max_daily_count: null,
    redose_notice: 0,
    rxcui: null,
    rxcui_ingredients: null,
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
      { id: 10, item_id: 1 },
      { id: 11, item_id: 1 },
      { id: 12, item_id: 2 },
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
      { id: 10, item_id: 1 },
      { id: 20, item_id: 99 }, // inactive/deleted supplement
    ];
    const byId = new Map([[1, supp({ id: 1 })]]);
    const adh = supplementAdherenceToday(doses, byId, ctx, new Set([10, 20]));
    expect(adh).toEqual({ taken: 1, due: 1 });
  });

  it("excludes doses not due today via isDueOn (rest-day supplement on a workout day)", () => {
    const doses = [
      { id: 10, item_id: 1 },
      { id: 11, item_id: 2 },
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
    const doses = [{ id: 10, item_id: 1 }];
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

describe("pickNextAppointment", () => {
  const appt = (id: number, dueDate: string | null): UpcomingItem => ({
    key: `appointment:${id}`,
    domain: "appointment",
    title: `Visit ${id}`,
    href: "/encounters",
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

  it("keeps the first item on a same-day tie (feeds ordered by scheduled_at)", () => {
    const chosen = pickNextAppointment([
      appt(5, "2026-07-15"),
      appt(6, "2026-07-15"),
    ]);
    expect(chosen?.key).toBe("appointment:5");
  });

  // Fixture-parity guard for issue #303: the dashboard needs-attention hero and the
  // household card must select the SAME appointment from the same source. Both derive
  // from getScheduledAppointments (ordered scheduled_at ASC, id ASC) — the household
  // maps each row to an UpcomingItem { dueDate }, the dashboard to { appt, dueDate } —
  // so this pins that pickNextAppointment picks the identical row from either shape.
  describe("dashboard vs household parity", () => {
    // Raw scheduled appointments in getScheduledAppointments order, with the
    // issue's disagreement case (an overdue visit alongside a future one) plus a
    // same-day pair to exercise the tie-break.
    const rawScheduled = [
      { id: 10, scheduled_at: "2026-06-27T09:00:00" }, // overdue, ~2 weeks ago
      { id: 11, scheduled_at: "2026-07-18T14:30:00" }, // next week
      { id: 12, scheduled_at: "2026-07-18T08:00:00" }, // same day, earlier slot
    ];

    // Household surface: appointmentItems maps rows to UpcomingItems keyed by id.
    const householdItems: UpcomingItem[] = rawScheduled.map((a) => ({
      key: `appointment:${a.id}`,
      domain: "appointment",
      title: `Visit ${a.id}`,
      href: "/encounters",
      dueDate: a.scheduled_at.slice(0, 10),
    }));

    // Dashboard surface: the page wraps each row with its calendar dueDate.
    const dashboardItems = rawScheduled.map((a) => ({
      appt: a,
      dueDate: a.scheduled_at.slice(0, 10),
    }));

    it("both surfaces pick the same appointment id", () => {
      const household = pickNextAppointment(householdItems);
      const dashboard = pickNextAppointment(dashboardItems);
      expect(household?.key).toBe("appointment:10");
      expect(dashboard?.appt.id).toBe(10);
    });
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
    const hi = goalHighlights(goals, new Map(), "2026-06-01", 2);
    expect(hi.map((h) => h.title)).toEqual(["A", "D"]);
    expect(hi[0].pct).toBe(50);
    expect(hi[1].pct).toBeNull();
    // Bar tint is the shared pace map: a dateless in-progress goal → on-pace (brand),
    // never a raw-completion rose; a goal with no numeric basis renders no bar.
    expect(hi[0].barClass).toBe("bg-brand-500");
    expect(hi[1].barClass).toBe("");
  });
});
