// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// The Trends → Nutrition "Macros & fiber" chart reads BOTH protein sources (#2414).
// It used to read only tracked `protein_g` metric samples, so a profile that logs
// protein through the Food tab's quick-add (`protein_log`, #824) saw the empty state
// at the app's only long-range nutrition chart.
//
// This drives the real gather the section calls — getMacroFiberDays — over one day set
// carrying BOTH sources, so the selection rule is asserted where the bug lived rather
// than only in the pure merge. The precedence is #824's, per day: tracked overrides,
// logged fills, never summed.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getMacroFiberDays } from "@/lib/queries";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function seedTracked(
  profileId: number,
  metric: string,
  date: string,
  value: number
) {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health_connect', ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    metric,
    date,
    `${date}T08:00:00Z`,
    `${date}T08:00:00Z`,
    value
  );
}

// A fixed window well inside any range bound, so the assertions are about the merge
// and never about the clock.
const D1 = "2026-03-02"; // tracked only
const D2 = "2026-03-03"; // BOTH sources
const D3 = "2026-03-04"; // logged only
const RANGE = { from: "2026-03-01", to: "2026-03-31" };

describe("Macros & fiber protein selection (#2414)", () => {
  it("takes the tracked value where one exists and the logged value where it does not", () => {
    const p = newProfile("macro-both-sources");
    seedTracked(p, "protein_g", D1, 132);
    seedTracked(p, "protein_g", D2, 148);
    // The same three days also carry carbs, so the day set is identical across
    // sources and the protein column is the only variable.
    for (const d of [D1, D2, D3]) seedTracked(p, "carbs_g", d, 210);

    // The Food-tab quick-add's own write core, not a hand-built row.
    expect(addProteinGramsCore(p, D2, 30)).toEqual({
      kind: "logged",
      grams: 30,
    });
    expect(addProteinGramsCore(p, D3, 55)).toEqual({
      kind: "logged",
      grams: 55,
    });

    const series = getMacroFiberDays(p, RANGE);
    expect(series.map((r) => r.date)).toEqual([D1, D2, D3]);
    expect(series.map((r) => r.protein)).toEqual([
      132, // tracked only
      148, // BOTH — the tracked total wins, and 148 ≠ 178: never summed
      55, // logged only — the day the chart used to miss entirely
    ]);
    // The other macros are untouched by the merge.
    expect(series.map((r) => r.carbs)).toEqual([210, 210, 210]);
  });

  it("renders a chart at all for a profile whose only protein is hand-logged", () => {
    const p = newProfile("macro-logged-only");
    addProteinGramsCore(p, D1, 40);
    addProteinGramsCore(p, D3, 45);

    const series = getMacroFiberDays(p, RANGE);
    // Previously empty — the empty state where months of logging live.
    expect(series.map((r) => r.date)).toEqual([D1, D3]);
    expect(series.map((r) => r.protein)).toEqual([40, 45]);
    // A logged-only day HAS a row, its other macros zero (the existing
    // buildMacroFiberSeries contract).
    expect(series[0]).toMatchObject({ carbs: 0, fat: 0, fiber: 0 });
  });

  it("leaves a tracked-only profile's series exactly as it was", () => {
    const p = newProfile("macro-tracked-only");
    seedTracked(p, "protein_g", D1, 132);
    seedTracked(p, "fiber_g", D1, 31);

    expect(getMacroFiberDays(p, RANGE)).toEqual([
      { date: D1, protein: 132, carbs: 0, fat: 0, fiber: 31 },
    ]);
  });

  it("windows the logged source to the selected range like every other series", () => {
    const p = newProfile("macro-window");
    addProteinGramsCore(p, "2026-02-10", 60); // before the range
    addProteinGramsCore(p, D2, 70);
    addProteinGramsCore(p, "2026-04-10", 80); // after the range

    expect(getMacroFiberDays(p, RANGE).map((r) => r.date)).toEqual([D2]);
    // An all-time range (no bounds) keeps every day.
    expect(getMacroFiberDays(p, {}).map((r) => r.date)).toEqual([
      "2026-02-10",
      D2,
      "2026-04-10",
    ]);
  });
});
