// DB INTEGRATION TIER — the fiber × GI-symptom panel gather (#2788).
//
// The pure tier proves the assembly; this proves the PATH: the daily fiber leg reads
// the same per-day gather the Food picker reads (catalog floor, so a legumes serving
// carries its fiber_g), the symptom leg reads the same rollup reader the timeline
// reads, a day with no signal is null rather than zero, non-GI symptoms never mark a
// day, and the whole thing is profile-scoped.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getFiberSymptomPanel } from "@/lib/queries";
import { foodGroupBySlug } from "@/lib/food-groups";
import { fiberSymptomPanelHasSignal } from "@/lib/fiber-symptom-panel";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function logServings(
  profileId: number,
  date: string,
  group: string,
  servings: number
): void {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, group, servings);
}

function logSymptom(
  profileId: number,
  date: string,
  symptom: string,
  severity: number
): void {
  db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, symptom, severity);
}

describe("getFiberSymptomPanel (#2788)", () => {
  it("aligns both series on the profile's own days, null for no-signal days", () => {
    const p = makeProfile("fiber-gi-panel");
    const t = today(p);
    const d1 = shiftDateStr(t, -3); // legumes day
    const d2 = shiftDateStr(t, -2); // symptom-only day
    const d3 = shiftDateStr(t, -1); // zero-fiber logged day

    logServings(p, d1, "legumes", 2);
    logSymptom(p, d2, "bloating", 3);
    // A day with ONLY a zero-fiber group logged is an honest 0 g, not an absence.
    logServings(p, d3, "fatty_fish", 1);

    const panel = getFiberSymptomPanel(p);
    expect(panel.days).toHaveLength(28);
    expect(panel.days[panel.days.length - 1].date).toBe(t);

    const byDate = new Map(panel.days.map((d) => [d.date, d]));
    // The fiber leg is the catalog floor — the same figure the Food picker states.
    const legumesFiber = foodGroupBySlug("legumes")!.fiber_g!;
    expect(byDate.get(d1)!.grams).toBe(2 * legumesFiber);
    expect(byDate.get(d2)!.grams).toBeNull();
    expect(byDate.get(d2)!.symptoms).toEqual([
      { symptom: "bloating", severity: 3 },
    ]);
    expect(byDate.get(d3)!.grams).toBe(0);
    // An unlogged day inside the window is an absence, never a zero-gram claim.
    expect(byDate.get(shiftDateStr(t, -10))!.grams).toBeNull();

    expect(fiberSymptomPanelHasSignal(panel)).toBe(true);
  });

  it("marks only GI symptoms — a headache day carries no dot", () => {
    const p = makeProfile("fiber-gi-panel-filter");
    const t = today(p);
    logServings(p, shiftDateStr(t, -1), "legumes", 1);
    logSymptom(p, shiftDateStr(t, -1), "headache", 4);

    const panel = getFiberSymptomPanel(p);
    expect(panel.days.every((d) => d.symptoms.length === 0)).toBe(true);
    // Fiber alone is nothing to co-read — the surface renders nothing.
    expect(fiberSymptomPanelHasSignal(panel)).toBe(false);
  });

  it("is profile-scoped — a neighbour's servings and symptoms do not leak in", () => {
    const p = makeProfile("fiber-gi-panel-scope");
    const other = makeProfile("fiber-gi-panel-other");
    const t = today(p);
    logServings(other, shiftDateStr(t, -1), "legumes", 3);
    logSymptom(other, shiftDateStr(t, -1), "diarrhea", 4);

    const panel = getFiberSymptomPanel(p);
    expect(panel.days.every((d) => d.grams === null)).toBe(true);
    expect(panel.days.every((d) => d.symptoms.length === 0)).toBe(true);
  });
});
