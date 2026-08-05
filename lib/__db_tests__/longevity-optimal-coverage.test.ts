// #2023 — the ONE gather behind the optimal-biomarker pillar feeds BOTH the pillar's
// counts and the Longevity page's expanded rows, and both now carry the same freshness
// and coverage facts. This pins that against a real schema: the pillar's stale count is
// exactly the set of rows marked "due", the pillar's denominator is exactly the row count,
// and an old-only panel never reaches the page as a current green result.
// All fixture values are synthetic (obviously-fictional profile, plain analyte names).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getHealthspanPillars,
  getOptimalHitRate,
  getOptimalShareRows,
} from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A lab reading under a canonical analyte the committed dataset curates, so the join in
// gatherOptimalReadings resolves a real optimal band.
function insertLab(
  profileId: number,
  canonical: string,
  valueNum: number,
  unit: string,
  date: string
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    canonical,
    String(valueNum),
    valueNum,
    unit,
    canonical
  );
}

function pillar(profileId: number) {
  return getHealthspanPillars(profileId).find(
    (p) => p.key === "optimal-biomarkers"
  );
}

describe("the optimal pillar and its expanded rows share one gather (#2023)", () => {
  it("counts, freshness and coverage reconcile row-for-row", () => {
    const pid = createProfile("Optimal Coverage Fixture");
    const now = today(pid);
    const recent = shiftDateStr(now, -20);
    const ancient = shiftDateStr(now, -900);
    insertLab(pid, "Total Cholesterol", 170, "mg/dL", recent);
    insertLab(pid, "HDL Cholesterol", 70, "mg/dL", recent);
    insertLab(pid, "Triglycerides", 300, "mg/dL", ancient);

    const rate = getOptimalHitRate(pid);
    const rows = getOptimalShareRows(pid);

    // The expanded view is a formatter over the pillar's own computation.
    expect(rows.length).toBe(rate.total);
    expect(rows.filter((r) => r.badge === "optimal").length).toBe(rate.optimal);
    expect(rows.filter((r) => r.freshness === "due").length).toBe(
      rate.freshness.due
    );
    expect(rows.filter((r) => r.freshness === "current").length).toBe(
      rate.freshness.current
    );
    // Freshness came from the real dates, not from a default.
    expect(rate.freshness.due).toBeGreaterThan(0);
    expect(rate.freshness.current).toBeGreaterThan(0);
    expect(rate.latestDate).toBe(recent);
    expect(rate.oldestDate).toBe(ancient);
    for (const r of rows) expect(r.date).toBeTruthy();

    // The pillar the widget and the page render is built from that same model.
    const p = pillar(pid);
    expect(p?.value).toBe(`${rate.optimal} of ${rate.total}`);
    expect(p?.detail).toContain("based on older results");
  });

  it("a narrow panel discloses that it is narrow", () => {
    const pid = createProfile("Narrow Panel Fixture");
    const now = today(pid);
    insertLab(pid, "Total Cholesterol", 170, "mg/dL", shiftDateStr(now, -10));

    expect(getOptimalHitRate(pid).coverage).toBe("narrow");
    expect(pillar(pid)?.detail).toContain("narrow panel");
  });

  it("an old-only panel is neutral, never a current-looking green result", () => {
    const pid = createProfile("Stale Panel Fixture");
    const ancient = shiftDateStr(today(pid), -1200);
    insertLab(pid, "Total Cholesterol", 170, "mg/dL", ancient);
    insertLab(pid, "HDL Cholesterol", 70, "mg/dL", ancient);

    const rate = getOptimalHitRate(pid);
    expect(rate.freshness.current).toBe(0);
    expect(rate.freshness.due).toBe(rate.total);
    const p = pillar(pid);
    // The favorable ratio survives — the model is not re-scored, only re-described.
    expect(p?.value).toBe(`${rate.optimal} of ${rate.total}`);
    expect(p?.tone).toBe("neutral");
    expect(getOptimalShareRows(pid).every((r) => r.freshness === "due")).toBe(
      true
    );
  });

  it("a fresh panel keeps its judgment", () => {
    const pid = createProfile("Fresh Panel Fixture");
    const recent = shiftDateStr(today(pid), -5);
    insertLab(pid, "Total Cholesterol", 170, "mg/dL", recent);
    insertLab(pid, "HDL Cholesterol", 70, "mg/dL", recent);

    const rate = getOptimalHitRate(pid);
    expect(rate.freshness.due).toBe(0);
    expect(rate.freshness.current).toBe(rate.total);
    expect(pillar(pid)?.detail).toContain("all current");
    expect(pillar(pid)?.tone).not.toBe("neutral");
  });
});
