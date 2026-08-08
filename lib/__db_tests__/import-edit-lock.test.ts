// DB INTEGRATION TIER — edit-lock uniformity as a PROPERTY (issue #2091).
//
// "Sync never overwrites a manual correction" was a stated invariant enforced by
// convention plus the observation-substrate text scan — which checks that ingest
// paths CALL isEditLocked, not that every importer-written table's write path
// actually REFUSES the overwrite. This file converts the assumption into behavior:
// for every table the shared importer writes, an imported row that has been
// hand-edited survives a re-import that tries to change it, and the sync
// accounting reports the hold-out in its own `edited` split (#133/#659) rather
// than `updated`.
//
// The manual edit is simulated by setting the row's value and its `edited` flag
// directly — the post-image the Review resolver's save leaves behind — because
// this test pins the IMPORTER's behavior against that state, not the editor's
// (the editors have their own action-tier coverage).
//
// The census at the bottom keeps the property total: every `INSERT INTO <table>`
// in lib/integrations/normalize.ts must be either lock-tested here or declared
// source-owned with the reason. A new importer-written table therefore cannot
// ship without deciding, in writing, whether a person's correction can outlive
// the next sync.

import { describe, it, expect } from "vitest";
import { toKg, toKm } from "@/lib/units";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertPracticeLogs,
  upsertVitals,
} from "@/lib/integrations/normalize";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const SOURCE = "oura";
const DATE = "2026-03-04";

/**
 * Tables whose importer path must hold out a hand-edited row. `run` performs:
 * import → manual edit (value + `edited` flag) → re-import with a changed value —
 * and returns the surviving stored value plus the re-import's counts.
 */
const LOCKED: {
  table: string;
  run: (profileId: number) => {
    stored: unknown;
    manual: unknown;
    counts: { updated: number; edited: number };
  };
}[] = [
  {
    table: "practice_logs",
    run(p) {
      const row = {
        external_id: "ext-practice-1",
        practice: "Meditation",
        date: DATE,
        time: "07:00",
        duration_min: 10,
      };
      upsertPracticeLogs(p, [row], SOURCE);
      db.prepare(
        "UPDATE practice_logs SET duration_min = 25, edited = 1 WHERE profile_id = ? AND external_id = ?"
      ).run(p, row.external_id);
      const counts = upsertPracticeLogs(
        p,
        [{ ...row, duration_min: 15 }],
        SOURCE
      );
      const stored = db
        .prepare(
          "SELECT duration_min FROM practice_logs WHERE profile_id = ? AND external_id = ?"
        )
        .get(p, row.external_id) as { duration_min: number };
      return { stored: stored.duration_min, manual: 25, counts };
    },
  },
  {
    table: "body_metrics",
    run(p) {
      upsertBodyMetrics(p, [{ date: DATE, weight_kg: toKg(80, "kg") }], SOURCE);
      db.prepare(
        "UPDATE body_metrics SET weight_kg = 79.5, edited = 1 WHERE profile_id = ? AND date = ? AND source = ?"
      ).run(p, DATE, SOURCE);
      const counts = upsertBodyMetrics(
        p,
        [{ date: DATE, weight_kg: toKg(81, "kg") }],
        SOURCE
      );
      const stored = db
        .prepare(
          "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ? AND source = ?"
        )
        .get(p, DATE, SOURCE) as { weight_kg: number };
      return { stored: stored.weight_kg, manual: 79.5, counts };
    },
  },
  {
    table: "metric_samples",
    run(p) {
      const row = {
        metric: "steps",
        date: DATE,
        start_time: "2026-03-04T00:00:00Z",
        end_time: "2026-03-04T23:59:00Z",
        value: 9000,
      };
      upsertMetricSamples(p, [row], SOURCE);
      db.prepare(
        "UPDATE metric_samples SET value = 9500, edited = 1 WHERE profile_id = ? AND metric = ? AND source = ? AND start_time = ?"
      ).run(p, row.metric, SOURCE, row.start_time);
      const counts = upsertMetricSamples(p, [{ ...row, value: 12000 }], SOURCE);
      const stored = db
        .prepare(
          "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? AND start_time = ?"
        )
        .get(p, row.metric, SOURCE, row.start_time) as { value: number };
      return { stored: stored.value, manual: 9500, counts };
    },
  },
  {
    table: "medical_records",
    run(p) {
      const row = {
        external_id: "health-connect:spo2:2026-03-04T08:00:00Z",
        date: DATE,
        category: "vitals" as const,
        name: "Oxygen Saturation",
        canonical: "Oxygen Saturation",
        value_num: 97,
        unit: "%",
      };
      upsertVitals(p, [row], "health-connect");
      db.prepare(
        "UPDATE medical_records SET value_num = 98, edited = 1 WHERE profile_id = ? AND external_id = ?"
      ).run(p, row.external_id);
      const { counts } = upsertVitals(
        p,
        [{ ...row, value_num: 95 }],
        "health-connect"
      );
      const stored = db
        .prepare(
          "SELECT value_num FROM medical_records WHERE profile_id = ? AND external_id = ?"
        )
        .get(p, row.external_id) as { value_num: number };
      return { stored: stored.value_num, manual: 98, counts };
    },
  },
  {
    table: "activities",
    run(p) {
      const row = {
        external_id: "oura:2026-03-04T18:00:00Z",
        date: DATE,
        type: "cardio" as const,
        title: "Evening run",
        duration_min: 30,
        distance_km: toKm(5, "km"),
        start_time: "18:00",
        end_time: "18:30",
      };
      upsertActivities(p, [row], SOURCE);
      db.prepare(
        "UPDATE activities SET duration_min = 32, edited = 1 WHERE profile_id = ? AND external_id = ?"
      ).run(p, row.external_id);
      const counts = upsertActivities(
        p,
        [{ ...row, duration_min: 45 }],
        SOURCE
      );
      const stored = db
        .prepare(
          "SELECT duration_min FROM activities WHERE profile_id = ? AND external_id = ?"
        )
        .get(p, row.external_id) as { duration_min: number };
      return { stored: stored.duration_min, manual: 32, counts };
    },
  },
];

/**
 * Importer-written tables with NO edit lock, each with the reason it is safe —
 * the declared source-owned/append-only set. An entry here is a decision, not an
 * omission.
 */
const SOURCE_OWNED: Record<string, string> = {
  hr_minutes:
    "minute-grain samples with no per-row delete or edit path (#653) — " +
    "source-owned by construction, outside the reading model's grain boundary",
  activity_routes:
    "the GPS trace child of an imported activity; replaced wholesale with its " +
    "parent's re-sync and never hand-edited row by row",
};

describe("every importer-written table honors the edit lock (#2091)", () => {
  for (const { table, run } of LOCKED) {
    it(`${table}: a hand-edited imported row survives re-import`, () => {
      const p = newProfile(`edit-lock ${table}`);
      const { stored, manual, counts } = run(p);
      expect(stored, `${table}: the manual correction was overwritten`).toEqual(
        manual
      );
      expect(
        counts.updated,
        `${table}: the hold-out was counted as a write`
      ).toBe(0);
      expect(
        counts.edited,
        `${table}: the hold-out must be visible in the edited split (#659)`
      ).toBe(1);
    });
  }

  it("an unedited row still updates normally (the lock is not a freeze)", () => {
    const p = newProfile("edit-lock control");
    upsertBodyMetrics(p, [{ date: DATE, weight_kg: toKg(80, "kg") }], SOURCE);
    const counts = upsertBodyMetrics(
      p,
      [{ date: DATE, weight_kg: toKg(81, "kg") }],
      SOURCE
    );
    expect(counts.updated).toBe(1);
    expect(counts.edited).toBe(0);
    const stored = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ? AND source = ?"
      )
      .get(p, DATE, SOURCE) as { weight_kg: number };
    expect(stored.weight_kg).toBe(81);
  });

  it("the census is total: every table normalize.ts writes is locked or declared", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib", "integrations", "normalize.ts"),
      "utf8"
    );
    const written = new Set<string>();
    for (const m of src.matchAll(/INSERT INTO (\w+)/g)) written.add(m[1]);
    expect(written.size).toBeGreaterThanOrEqual(7); // not vacuous
    const covered = new Set([
      ...LOCKED.map((l) => l.table),
      ...Object.keys(SOURCE_OWNED),
    ]);
    const undeclared = [...written].filter((t) => !covered.has(t));
    expect(
      undeclared,
      "normalize.ts writes these tables, but nothing here decides whether a " +
        "person's correction survives their re-sync. Add a LOCKED entry (and the " +
        "lock, if the table lacks one) or declare the table in SOURCE_OWNED with " +
        "the reason:\n" +
        undeclared.join("\n")
    ).toEqual([]);
    // And no stale declarations for tables the importer no longer writes.
    const stale = [...covered].filter((t) => !written.has(t));
    expect(stale, `declared but never written by normalize.ts`).toEqual([]);
  });
});
