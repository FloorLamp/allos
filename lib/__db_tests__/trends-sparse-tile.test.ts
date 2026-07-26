// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// #1485 G — Trends opens on a 90D window instead of all time, and a saved
// biomarker with no readings IN that window falls back to its latest reading +
// age rather than "No data in this range".
//
// This tier is where the fallback has to be proven: the pure tier can see the
// selection rule (lib/__tests__/trends.test.ts pins outOfWindowLatest) but not the
// INPUT LAYER around it — which rows the builder gathers, which unit it resolves,
// and whether a qualitative reading survives the numeric plot filter. Those are
// exactly the seams the #448 rule was written about.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { buildSavedBiomarkerTile } from "@/lib/trends-series";
import { defaultTrendsRange } from "@/lib/timeline-format";
import { shiftDateStr } from "@/lib/date";

// Deliberately non-canonical analyte names: the fallback must resolve a unit from
// the reading itself, which is the harder path (a canonical biomarker would supply
// one). Synthetic values throughout — no real PHI.
const STALE_ANALYTE = "Testonium";
const FRESH_ANALYTE = "Freshonium";
const GENOTYPE_ANALYTE = "Testotype";
const NEVER_MEASURED = "Neveronium";

describe("#1485 G — the sparse-series tile falls back to the latest reading", () => {
  let profileId: number;
  let todayStr: string;
  let staleDate: string;

  const insertLab = (
    name: string,
    date: string,
    value: string,
    valueNum: number | null,
    unit: string | null
  ) =>
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
      )
      .run(profileId, date, name, value, valueNum, unit, name);

  beforeAll(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SparseTile')").run()
        .lastInsertRowid
    );
    todayStr = today(profileId);
    // Well outside a 90-day window — the annual-lab shape the fallback exists for.
    staleDate = shiftDateStr(todayStr, -400);

    insertLab(STALE_ANALYTE, shiftDateStr(todayStr, -800), "40", 40, "ng/mL");
    insertLab(STALE_ANALYTE, staleDate, "55", 55, "ng/mL");
    // Drawn inside the default window.
    insertLab(FRESH_ANALYTE, shiftDateStr(todayStr, -10), "12", 12, "mg/dL");
    // A qualitative reading: no numeric value at all, so nothing is plottable.
    insertLab(GENOTYPE_ANALYTE, staleDate, "e3/e4", null, null);
  });

  it("shows the latest reading and its age when the default window is empty", () => {
    const tile = buildSavedBiomarkerTile(
      profileId,
      STALE_ANALYTE,
      defaultTrendsRange(todayStr),
      todayStr
    );
    // Nothing is PLOTTED — the stale reading is carried beside the points, never
    // merged into them, so no chart can draw a 400-day-old value as in-window.
    expect(tile.points).toEqual([]);
    expect(tile.outsideWindow).toBeTruthy();
    // The NEWEST reading (55), not the oldest (40), in the reading's own unit.
    expect(tile.outsideWindow?.text).toBe("55 ng/mL");
    expect(tile.outsideWindow?.date).toBe(staleDate);
    // The age is the honesty marker and is never absent.
    expect(tile.outsideWindow?.age).toBe("1y ago");
    // The title node stays EXACTLY the analyte name (the age lives in its own
    // field, so an exact-text lookup for the analyte still matches — e2e relies
    // on this).
    expect(tile.label).toBe(STALE_ANALYTE);
  });

  it("draws the real series — and no fallback — when the window has readings", () => {
    const tile = buildSavedBiomarkerTile(
      profileId,
      FRESH_ANALYTE,
      defaultTrendsRange(todayStr),
      todayStr
    );
    expect(tile.points).toHaveLength(1);
    expect(tile.points[0].value).toBe(12);
    // A fallback here would duplicate the headline value and imply staleness.
    expect(tile.outsideWindow ?? null).toBeNull();
  });

  it("draws the full series under an explicit all-time window", () => {
    const tile = buildSavedBiomarkerTile(
      profileId,
      STALE_ANALYTE,
      {},
      todayStr
    );
    expect(tile.points.map((p) => p.value)).toEqual([40, 55]);
    expect(tile.outsideWindow ?? null).toBeNull();
  });

  // The APOE-genotype case: starred, real in the seed, and invisible to a
  // numeric-only fallback.
  it("falls back to a qualitative reading, which nothing can plot", () => {
    const tile = buildSavedBiomarkerTile(
      profileId,
      GENOTYPE_ANALYTE,
      defaultTrendsRange(todayStr),
      todayStr
    );
    expect(tile.points).toEqual([]);
    expect(tile.outsideWindow?.text).toBe("e3/e4");
    expect(tile.outsideWindow?.age).toBe("1y ago");
  });

  // #1456: a never-measured saved biomarker still renders a tile so its ★ stays
  // reachable — there is simply no reading to fall back to.
  it("keeps the plain placeholder for a never-measured analyte", () => {
    const tile = buildSavedBiomarkerTile(
      profileId,
      NEVER_MEASURED,
      defaultTrendsRange(todayStr),
      todayStr
    );
    expect(tile.points).toEqual([]);
    expect(tile.outsideWindow ?? null).toBeNull();
    expect(tile.label).toBe(NEVER_MEASURED);
  });
});
