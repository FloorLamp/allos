// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1297 — the situation-window impact gather over a realistic fixture (#448). The
// pooling math + window derivation are pinned pure in lib/__tests__/situation-impact.test.ts;
// this seeds a real declared Travel transition log + body-metric series and asserts the
// END-TO-END card output (windows → pooled deltas). Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, setProfileSetting } from "@/lib/settings";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import { getSituationImpacts } from "@/lib/queries";

let seq = 0;
function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`sit-impact-${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function bodyMetric(
  profileId: number,
  date: string,
  weightKg: number,
  restingHr: number
): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr) VALUES (?,?,?,?)"
  ).run(profileId, date, weightKg, restingHr);
}

describe("getSituationImpacts (#1297) — declared Travel window over real metrics", () => {
  it("pools the during-days vs the baseline and reports the honest shifts", () => {
    const p = newProfile();
    const on = today(p);
    // A past Travel window: start day-14, stop day-9 → during [day-14, day-10] (5 days),
    // baseline [day-19, day-15].
    const start = shiftDateStr(on, -14);
    const stop = shiftDateStr(on, -9);
    const events = [
      ...diffSituations([], ["Travel"], start),
      ...diffSituations(["Travel"], [], stop),
    ];
    setProfileSetting(
      p,
      "situation_events",
      serializeSituationEvents([], events)
    );

    // Baseline days: weight 80, resting HR 50. During days: weight 81, resting HR 56.
    for (let d = -19; d <= -15; d++) bodyMetric(p, shiftDateStr(on, d), 80, 50);
    for (let d = -14; d <= -10; d++) bodyMetric(p, shiftDateStr(on, d), 81, 56);

    const impacts = getSituationImpacts(p, on, "kg");
    const travel = impacts.find((i) => i.situation === "Travel");
    expect(travel).toBeTruthy();
    expect(travel!.windowCount).toBe(1);
    expect(travel!.duringDays).toBe(5);

    const weight = travel!.outcomes.find((o) => o.key === "metric:weight");
    const rhr = travel!.outcomes.find((o) => o.key === "metric:resting_hr");
    expect(weight?.meanDelta).toBeCloseTo(1, 5);
    expect(rhr?.meanDelta).toBeCloseTo(6, 5);
    // Resting HR rising is "worse" (lower_better); weight is neutral (no verdict).
    expect(rhr?.betterness).toBe("worse");
    expect(weight?.betterness).toBe("unknown");

    // SRI has no sleep data seeded → insufficient → filtered off the card (absent-pillar).
    expect(travel!.outcomes.some((o) => o.key === "index:sri")).toBe(false);
  });

  it("renders no card for a situation without enough windowed history", () => {
    const p = newProfile();
    const on = today(p);
    // A one-day Travel toggle (start day-3, stop day-2 → during is just day-3): under the
    // during-days floor, so no card.
    const events = [
      ...diffSituations([], ["Travel"], shiftDateStr(on, -3)),
      ...diffSituations(["Travel"], [], shiftDateStr(on, -2)),
    ];
    setProfileSetting(
      p,
      "situation_events",
      serializeSituationEvents([], events)
    );
    bodyMetric(p, shiftDateStr(on, -3), 81, 56);
    expect(getSituationImpacts(p, on, "kg")).toEqual([]);
  });

  it("returns nothing when there is no transition log at all", () => {
    const p = newProfile();
    expect(getSituationImpacts(p, today(p), "kg")).toEqual([]);
  });
});
