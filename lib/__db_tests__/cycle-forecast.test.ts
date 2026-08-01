// DB INTEGRATION TIER — the #1679 forecast READER: the profile-scoped period history plus
// the resolved suspension, handed to the one pure projection. Proves the gather (not the
// arithmetic — that is lib/__tests__/cycle-forecast.test.ts) and the two suspensions,
// which are the parts that can only be wrong against a real database.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { FORECAST_MIN_CYCLES } from "@/lib/cycle";
import { getCycleForecast, getForecastSuspension } from "@/lib/cycle-store";
import {
  EMPTY_RISK_ATTRIBUTES,
  setRiskAttributes,
  setUserReproductiveStatus,
} from "@/lib/settings";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Seed consecutive periods from cycle LENGTHS, ending `endAgo` days before today, so every
// fixture date is relative and nothing is pinned near a fixed calendar day.
function seedCycles(
  profileId: number,
  lengths: number[],
  endAgo: number
): void {
  const anchor = today(profileId);
  const total = lengths.reduce((a, b) => a + b, 0);
  let ago = endAgo + total;
  const insert = db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end, flow)
     VALUES (?, ?, ?, 'medium')`
  );
  for (const len of [...lengths, 0]) {
    insert.run(
      profileId,
      shiftDateStr(anchor, -ago),
      shiftDateStr(anchor, -(ago - 4))
    );
    ago -= len;
  }
}

describe("getCycleForecast — the reader over a real history", () => {
  it("projects a narrow window from six regular cycles", () => {
    const p = newProfile("forecast-regular");
    seedCycles(p, [28, 28, 28, 28, 28, 28], 10);
    const f = getCycleForecast(p, today(p));
    expect(f.kind).toBe("forecast");
    if (f.kind !== "forecast") return;
    expect(f.evidence.cycleCount).toBe(6);
    expect(f.confidence).toBe("narrow");
    // 28 days after a period that started 10 days ago → 18 days out.
    expect(f.projectedStart).toBe(shiftDateStr(today(p), 18));
    expect(f.ovulationEstimate).not.toBeNull();
  });

  it("widens and labels a wildly varying history", () => {
    const p = newProfile("forecast-irregular");
    seedCycles(p, [22, 41, 26, 35, 24, 38], 6);
    const f = getCycleForecast(p, today(p));
    expect(f.kind).toBe("forecast");
    if (f.kind !== "forecast") return;
    expect(f.confidence).toBe("wide");
    expect(f.evidence.variabilityDays).toBe(19);
    expect(f.halfWidthDays).toBeGreaterThan(2);
  });

  it("gives a one-cycle profile nothing at all", () => {
    const p = newProfile("forecast-thin");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end) VALUES (?, ?, ?)`
    ).run(p, shiftDateStr(anchor, -20), shiftDateStr(anchor, -16));
    const f = getCycleForecast(p, anchor);
    expect(f).toEqual({ kind: "insufficient", cycleCount: 0 });
  });

  it("stays under the threshold with two completed cycles", () => {
    const p = newProfile("forecast-two");
    seedCycles(p, [28, 28], 5);
    const f = getCycleForecast(p, today(p));
    expect(f.kind).toBe("insufficient");
    if (f.kind === "insufficient")
      expect(f.cycleCount).toBe(FORECAST_MIN_CYCLES - 1);
  });

  it("reads only its OWN profile's periods", () => {
    const mine = newProfile("forecast-mine");
    const other = newProfile("forecast-other");
    seedCycles(other, [28, 28, 28, 28], 8);
    expect(getCycleForecast(mine, today(mine)).kind).toBe("insufficient");
    expect(getCycleForecast(other, today(other)).kind).toBe("forecast");
  });
});

describe("getForecastSuspension — pregnancy and menopause silence the projection", () => {
  it("suspends for an ongoing pregnancy, however good the history", () => {
    const p = newProfile("forecast-pregnant");
    seedCycles(p, [28, 28, 28, 28, 28], 9);
    expect(getCycleForecast(p, today(p)).kind).toBe("forecast");

    setRiskAttributes(p, { ...EMPTY_RISK_ATTRIBUTES, pregnant: true });
    expect(getForecastSuspension(p)).toBe("pregnancy");
    expect(getCycleForecast(p, today(p))).toEqual({
      kind: "suspended",
      reason: "pregnancy",
    });
  });

  it("suspends for an explicit postmenopausal status", () => {
    const p = newProfile("forecast-postmeno");
    seedCycles(p, [28, 28, 28, 28, 28], 9);
    setUserReproductiveStatus(p, "postmenopausal");
    expect(getForecastSuspension(p)).toBe("postmenopausal");
    expect(getCycleForecast(p, today(p)).kind).toBe("suspended");

    // A premenopausal status does NOT suspend.
    setUserReproductiveStatus(p, "premenopausal");
    expect(getForecastSuspension(p)).toBeNull();
    expect(getCycleForecast(p, today(p)).kind).toBe("forecast");
  });
});
