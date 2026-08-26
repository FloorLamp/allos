// DB INTEGRATION TIER — #3397's route-level Trends Overview statement budget.
//
// Render the actual async TrendingDigest Server Component for a seeded profile.
// Counting only its supplemental UNION would miss canonical cadence and nutrition
// reads added beside it, so the budget stays at the route boundary.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import {
  buildDigestSeries,
  buildPracticeDigestSeries,
} from "@/lib/trends-series";
import { getFindingSuppressions } from "@/lib/queries";
import { setActingSession } from "../__action_tests__/session-state";

let loginId = 0;

const RANGE_DAYS = 62;
const PRE_SUPPLEMENTAL_ROUTE_BASELINE = 32;
const CURRENT_ROUTE_BASELINE = 14;

function newSeededProfile(name: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(profileId, "rolling");
  const on = today(profileId);
  const from = shiftDateStr(on, -RANGE_DAYS);
  db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
     VALUES (?, 'practice', 'Budget walk', 'budget walk', 2, ?)`
  ).run(profileId, `${shiftDateStr(from, -30)} 08:00:00`);
  for (const offset of [50, 43, 36, 29, 22, 15, 8, 1]) {
    const date = shiftDateStr(on, -offset);
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, 'Budget walk', ?)"
    ).run(profileId, date);
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)"
    ).run(profileId, date);
  }
  for (const [offset, metric, value] of [
    [8, "protein_g", 100],
    [1, "carbs_g", 200],
  ] as const) {
    const date = shiftDateStr(on, -offset);
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
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (?, ?, 'poultry', 1)`
    ).run(profileId, date);
  }
  return profileId;
}

async function countStatements(
  run: () => Promise<void> | void
): Promise<number> {
  let count = 0;
  const realPrepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof value === "function" &&
          ["get", "all", "run", "iterate"].includes(String(property))
        ) {
          return (...args: unknown[]) => {
            count += 1;
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare);
  try {
    await run();
    return count;
  } finally {
    spy.mockRestore();
  }
}

describe("Trends Overview digest query budget (#3397)", () => {
  beforeAll(() => {
    loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
  });

  it("does not exceed the seeded pre-#3397 route baseline", async () => {
    const priorId = newSeededProfile("Trends budget prior");
    const currentId = newSeededProfile("Trends budget current");
    const priorRange = {
      from: shiftDateStr(today(priorId), -RANGE_DAYS),
      to: today(priorId),
    };
    const currentRange = {
      from: shiftDateStr(today(currentId), -RANGE_DAYS),
      to: today(currentId),
    };

    // Establish the same warmed module/settings state the historical comparison
    // used. The route assertion below is still independently bounded.
    await countStatements(() => {
      const on = today(priorId);
      buildDigestSeries(priorId, loginId, priorRange);
      buildPracticeDigestSeries(priorId, priorRange, on);
      getFindingSuppressions(priorId);
    });

    // The DB tier installs one shared auth seam whose calls delegate to this
    // mutable acting-session state. Steering that seam keeps this spec in the
    // shared module registry while the component still crosses requireSession.
    setActingSession({
      login: {
        id: loginId,
        username: "trends-budget",
        role: "admin",
      },
      profile: {
        id: currentId,
        name: "Trends budget current",
        photo_path: null,
        photo_version: 0,
      },
      access: "write",
      deviceSessionKey: "trends-budget-device",
    });
    const { default: TrendingDigest } =
      await import("../../app/(app)/trends/TrendingDigest");
    const current = await countStatements(async () => {
      await TrendingDigest({ range: currentRange });
    });

    expect(current).toBe(CURRENT_ROUTE_BASELINE);
    expect(current).toBeLessThanOrEqual(PRE_SUPPLEMENTAL_ROUTE_BASELINE);
  });
});
