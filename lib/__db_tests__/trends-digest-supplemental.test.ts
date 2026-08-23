// DB INTEGRATION TIER — #3397's one-query supplemental Trends digest gather.
// Proves the real-schema rows become nutrition and logging-cadence news, a steady
// persona stays silent, profile scoping holds, and the union executes as one
// statement rather than one read per ledger.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import { cadenceWindows } from "@/lib/queries/cadence-ledger";
import { getTrendsDigestGather } from "@/lib/queries/trends-digest";
import {
  buildLoggingCadenceDigestSeries,
  buildNutritionDigestSeries,
  buildPracticeDigestSeriesFromInputs,
  digestGatherBounds,
  supplementalDigestInputs,
} from "@/lib/trends-digest-series";
import { summarizeTrends } from "@/lib/trends-digest";
import { practiceIdentity } from "@/lib/practice";
import { getMacroFiberDays } from "@/lib/queries";

const NOW = new Date("2026-06-17T12:00:00Z");

function profile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(id, "rolling");
  return id;
}

function dateBack(profileId: number, days: number): string {
  return shiftDateStr(today(profileId), -days);
}

function seedProtein(profileId: number, values: readonly number[]): void {
  values.forEach((grams, index) => {
    const date = dateBack(profileId, values.length - index);
    db.prepare(
      `INSERT INTO protein_daily_totals (profile_id, date, grams)
       VALUES (?, ?, ?)`
    ).run(profileId, date, grams);
  });
}

function seedTrackedMetric(
  profileId: number,
  metric: string,
  date: string,
  value: number
): void {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    metric,
    date,
    `${date}T08:00:00Z`,
    `${date}T08:00:00Z`,
    value
  );
}

function seedFoodDay(profileId: number, date: string, servings = 1): void {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
     VALUES (?, ?, 'poultry', ?)`
  ).run(profileId, date, servings);
}

function seedDoseItem(profileId: number): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Digest dose', 1, 'supplement', 'daily', 'may')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 unit', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function seedTaken(
  dose: { itemId: number; doseId: number },
  date: string
): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
     VALUES (?, ?, ?, 'taken', '1 unit')`
  ).run(dose.doseId, dose.itemId, date);
}

function digestInputs(profileId: number, days = 62) {
  const range = { from: dateBack(profileId, days), to: today(profileId) };
  const windows = cadenceWindows(profileId, {
    weeks: 8,
    includeCurrent: false,
    asOf: today(profileId),
  });
  const bounds = digestGatherBounds(range, windows, today(profileId));
  const rows = getTrendsDigestGather(profileId, bounds);
  return {
    windows,
    gathered: supplementalDigestInputs(rows, windows, range),
  };
}

describe("supplemental Trends digest gather (#3397)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("surfaces a real protein collapse and keeps a steady profile silent", () => {
    const moved = profile("digest nutrition moved");
    const steady = profile("digest nutrition steady");
    seedProtein(moved, [100, 100, 100, 100, 50, 50, 50, 50]);
    seedProtein(steady, [80, 80, 80, 80, 80, 80, 80, 80]);

    const movedSeries = buildNutritionDigestSeries(
      digestInputs(moved).gathered
    );
    expect(summarizeTrends(movedSeries).map((item) => item.key)).toContain(
      "nutrition:protein"
    );
    expect(
      summarizeTrends(buildNutritionDigestSeries(digestInputs(steady).gathered))
    ).toEqual([]);
  });

  it("detects a food-group shift only across the selected Trends range", () => {
    const id = profile("digest food moved");
    seedFoodDay(id, dateBack(id, 20), 1);
    for (let back = 8; back >= 1; back--) {
      seedFoodDay(id, dateBack(id, back), back >= 5 ? 4 : 1);
    }

    const items = summarizeTrends(
      buildNutritionDigestSeries(digestInputs(id, 8).gathered)
    );
    expect(items.map((item) => item.key)).toContain(
      "nutrition:food-group:poultry"
    );
  });

  it("uses the Nutrition chart's zero-filled protein axis", () => {
    const id = profile("digest macro date axis");
    for (let back = 8; back >= 5; back--) {
      seedTrackedMetric(id, "protein_g", dateBack(id, back), 100);
    }
    for (let back = 4; back >= 1; back--) {
      seedTrackedMetric(id, "carbs_g", dateBack(id, back), 200);
    }

    const range = { from: dateBack(id, 8), to: dateBack(id, 1) };
    const windows = cadenceWindows(id, {
      weeks: 4,
      includeCurrent: false,
      asOf: range.to,
    });
    const rows = getTrendsDigestGather(
      id,
      digestGatherBounds(range, windows, today(id))
    );
    const gathered = supplementalDigestInputs(rows, windows, range);
    expect(gathered.proteinDays).toEqual(
      getMacroFiberDays(id, range).map((day) => ({
        date: day.date,
        value: day.protein,
      }))
    );
    expect(gathered.proteinDays.map((day) => day.value)).toEqual([
      100, 100, 100, 100, 0, 0, 0, 0,
    ]);
    expect(
      summarizeTrends(buildNutritionDigestSeries(gathered)).map(
        (item) => item.key
      )
    ).toContain("nutrition:protein");
  });

  it("keeps the tracked-practice cadence behavior on the batched path", () => {
    const id = profile("digest practice batched");
    const name = "Digest sauna";
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, scope_identity, per_week,
          created_at)
       VALUES (?, 'practice', ?, ?, 2, ?)`
    ).run(id, name, practiceIdentity(name), `${dateBack(id, 180)} 08:00:00`);
    const windows = cadenceWindows(id, {
      weeks: 8,
      includeCurrent: false,
      asOf: today(id),
    });
    windows.forEach((window, index) => {
      const count = index < 4 ? 1 : 4;
      for (let within = 0; within < count; within++) {
        db.prepare(
          `INSERT INTO practice_logs (profile_id, practice, date)
           VALUES (?, ?, ?)`
        ).run(id, name, shiftDateStr(window.start, within));
      }
    });

    const input = digestInputs(id);
    const [series] = buildPracticeDigestSeriesFromInputs(
      input.gathered.practiceTargets
    );
    expect(series).toMatchObject({
      key: `wellness:${practiceIdentity(name)}`,
      label: `${name} cadence`,
    });
    expect(series.range).toBeUndefined();
    expect(summarizeTrends([series]).map((item) => item.key)).toEqual([
      series.key,
    ]);
  });

  it("surfaces material food/dose/weighing cadence and not a steady logger", () => {
    const moved = profile("digest cadence moved");
    const steady = profile("digest cadence steady");
    const movedDose = seedDoseItem(moved);
    const steadyDose = seedDoseItem(steady);
    const movedWindows = cadenceWindows(moved, {
      weeks: 8,
      includeCurrent: false,
      asOf: today(moved),
    });
    const steadyWindows = cadenceWindows(steady, {
      weeks: 8,
      includeCurrent: false,
      asOf: today(steady),
    });

    for (let week = 0; week < 8; week++) {
      const movedCount = week < 4 ? 6 : 2;
      for (let within = 0; within < movedCount; within++) {
        const date = shiftDateStr(movedWindows[week].start, within);
        seedFoodDay(moved, date);
        seedTaken(movedDose, date);
        db.prepare(
          "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)"
        ).run(moved, date);
      }
      for (let within = 0; within < 3; within++) {
        const date = shiftDateStr(steadyWindows[week].start, within);
        seedFoodDay(steady, date);
        seedTaken(steadyDose, date);
        db.prepare(
          "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70)"
        ).run(steady, date);
      }
    }

    const movedInput = digestInputs(moved);
    const movedItems = summarizeTrends(
      buildLoggingCadenceDigestSeries({
        windows: movedInput.windows,
        foodDates: movedInput.gathered.foodDates,
        doseDates: movedInput.gathered.doseDates,
        weighingDates: movedInput.gathered.weighingDates,
      })
    );
    expect(movedItems.map((item) => item.key).sort()).toEqual([
      "logging:dose",
      "logging:food",
      "logging:weighing",
    ]);

    const steadyInput = digestInputs(steady);
    expect(
      summarizeTrends(
        buildLoggingCadenceDigestSeries({
          windows: steadyInput.windows,
          foodDates: steadyInput.gathered.foodDates,
          doseDates: steadyInput.gathered.doseDates,
          weighingDates: steadyInput.gathered.weighingDates,
        })
      )
    ).toEqual([]);
  });

  it("keeps steady weekly weighing quiet on a short selected range", () => {
    const id = profile("digest weighing short range");
    const windows = cadenceWindows(id, {
      weeks: 4,
      includeCurrent: false,
      asOf: today(id),
    });
    for (const window of windows) {
      db.prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)"
      ).run(id, window.start);
    }

    const range = { from: dateBack(id, 7), to: today(id) };
    const gathered = supplementalDigestInputs(
      getTrendsDigestGather(id, digestGatherBounds(range, windows, today(id))),
      windows,
      range
    );
    expect(gathered.weighingDates).toEqual(
      windows.map((window) => window.start)
    );
    expect(
      summarizeTrends(
        buildLoggingCadenceDigestSeries({
          windows,
          foodDates: [],
          doseDates: [],
          weighingDates: gathered.weighingDates,
        })
      )
    ).toEqual([]);
  });

  it("executes one batched statement and never reads another profile's rows", () => {
    const own = profile("digest query own");
    const other = profile("digest query other");
    seedProtein(own, [90, 90]);
    seedProtein(other, [10, 10]);
    seedFoodDay(other, dateBack(other, 2), 7);
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70)"
    ).run(other, dateBack(other, 2));

    const realPrepare = db.prepare.bind(db);
    let executions = 0;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = realPrepare(sql);
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "all" && typeof value === "function") {
            return (...args: unknown[]) => {
              executions += 1;
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.prepare);

    const rows = getTrendsDigestGather(own, {
      practiceFrom: dateBack(own, 90),
      proteinFrom: dateBack(own, 90),
      foodFrom: dateBack(own, 90),
      doseFrom: dateBack(own, 90),
      to: today(own),
    });
    expect(executions).toBe(1);
    expect(rows.filter((row) => row.kind === "protein-logged")).toHaveLength(2);
    expect(rows.some((row) => row.kind === "food-serving")).toBe(false);
    expect(rows.some((row) => row.kind === "weight-log")).toBe(false);
  });
});
