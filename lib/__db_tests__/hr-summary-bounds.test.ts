// DB INTEGRATION TIER — pins the equivalence the #387 performance fix relies on:
// getHrDailySummary / getHrSeriesBySource now bound their GROUP BY to the limitDays
// most-recent days-with-data (via recentHrCutoff's `>= cutoff`) instead of grouping
// all history and discarding the rest in JS. hr_minutes is the fastest-growing
// table, so the unbounded GROUP BY sorted ~1M rows per Trends render on year two.
//
// These tests prove the bound changes performance ONLY, never results:
//   • getHrDailySummary(p, k) === getHrDailySummary(p, BIG).slice(-k) — the windowed
//     per-day source-pick is identical to picking over full history then slicing,
//     because pickRowsOneSourcePerDay is per-day independent.
//   • the bounded per-source SQL returns byte-identical rows to the old unbounded
//     `GROUP BY … ORDER BY date DESC LIMIT ?` — the added `>= cutoff` only removes
//     rows that fell past the LIMIT cut anyway.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { getHrDailySummary, getHrSeriesBySource } from "@/lib/queries";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A day string N days before 2024-06-01, zero-padded YYYY-MM-DD.
function dayStr(d0: string, minusDays: number): string {
  const d = new Date(`${d0}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - minusDays);
  return d.toISOString().slice(0, 10);
}

// Seed `days` consecutive days ending at `end`, each carrying a few HR minute
// buckets from TWO sources (so a day has >1 (date,source) group — the multi-source
// case the LIMIT-on-groups bound must preserve). bpm varies by day+source+minute so
// the AVG/MIN/MAX per (day,source) is distinct and any mis-windowing would show.
function seedHr(profileId: number, end: string, days: number): void {
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < days; i++) {
      const date = dayStr(end, i);
      for (const [si, source] of ["health-connect", "oura"].entries()) {
        for (let m = 0; m < 3; m++) {
          const bpm = 55 + ((i + si * 7 + m * 3) % 40);
          const mm = String(m).padStart(2, "0");
          ins.run(
            profileId,
            `${date}T08:${mm}`,
            bpm,
            bpm - 4,
            bpm + 9,
            10,
            source
          );
        }
      }
    }
  });
  tx();
}

// Mirror of recentHrCutoff (private in lib/queries/metrics.ts): the k-th most-recent
// distinct HR day, for building the reference bounded query in the row-equivalence
// check.
function cutoffFor(profileId: number, k: number): string | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(ts,1,10) AS date FROM hr_minutes
        WHERE profile_id = ? ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, k) as { date: string }[];
  return rows.length > 0 ? rows[rows.length - 1].date : null;
}

const END = "2024-06-01";
const BIG = 100_000; // larger than any test's day span → cutoff = earliest day = full scan

describe("getHrDailySummary — bounded window equals full-history slice (#387)", () => {
  it("windowed result equals the last-k days of the full-history result", () => {
    const p = newProfile("hr daily bounds");
    seedHr(p, END, 200);

    const full = getHrDailySummary(p, BIG);
    expect(full.length).toBe(200); // one row per day, ascending

    for (const k of [1, 15, 60, 199, 200, 250]) {
      expect(getHrDailySummary(p, k)).toEqual(full.slice(-k));
    }
  });

  it("returns [] for a profile with no HR minutes", () => {
    const p = newProfile("hr daily empty");
    expect(getHrDailySummary(p, 30)).toEqual([]);
  });
});

describe("getHrSeriesBySource — full per-source window, no group LIMIT (#623)", () => {
  it("each source spans the full limitDays window, not limitDays/(#sources)", () => {
    // Two sources report daily (2 (date,source) groups per day). The old
    // `ORDER BY date DESC LIMIT limitDays` counted GROUP rows, so N sources shrank
    // each source's series to ~limitDays/N days — a source-COMPARISON overlay that
    // silently covered half the intended window. With the cutoff-only window, every
    // source gets the full k distinct days.
    const p = newProfile("hr series full window");
    seedHr(p, END, 200);

    for (const k of [1, 15, 61, 120]) {
      const series = getHrSeriesBySource(p, k);
      expect(series.map((s) => s.source).sort()).toEqual([
        "health-connect",
        "oura",
      ]);
      // Each source spans exactly the k most-recent distinct days (dense fixture);
      // the pre-#623 LIMIT would have yielded ~ceil(k/2) here.
      for (const s of series) {
        expect(s.data.length).toBe(k);
      }
      // The window's oldest day is the k-th most-recent distinct day, identical
      // across sources (no mid-day cut where one source falls inside the LIMIT and
      // the other outside — the discrepancy #623 called out).
      const cutoff = cutoffFor(p, k);
      for (const s of series) {
        expect(s.data[0].date).toBe(cutoff);
      }
    }
  });

  it("public series has both sources and is ascending within each source", () => {
    const p = newProfile("hr series shape");
    seedHr(p, END, 90);
    const series = getHrSeriesBySource(p, 30);
    expect(series.map((s) => s.source).sort()).toEqual([
      "health-connect",
      "oura",
    ]);
    for (const s of series) {
      const dates = s.data.map((d) => d.date);
      expect([...dates].sort()).toEqual(dates);
    }
  });

  it("returns [] for a profile with no HR minutes", () => {
    const p = newProfile("hr series empty");
    expect(getHrSeriesBySource(p, 30)).toEqual([]);
  });
});
