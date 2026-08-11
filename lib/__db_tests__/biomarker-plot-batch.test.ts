// The BATCHED biomarker-plot read (#1961) must answer exactly what the per-analyte
// read answered. The N+1 it removes sat under two hot paths — the dashboard's
// goal-pacing findings and the Training goal cards — and a perf change that quietly
// moves a rendered lab number is worse than the N+1 it fixes, so the whole point of
// this file is EQUIVALENCE, not speed.
//
// The comparison is real, not tautological: `getBiomarkerSeriesFor` short-circuits a
// SINGLE requested family to the untouched, cache()d `getBiomarkerSeries` (`= ?`) and
// only widens to the batched `IN (…)` query for two or more, so asking for one name
// at a time genuinely exercises the OLD code path and asking for all of them at once
// exercises the new one. Every assertion below compares those two.
//
// The fixture carries the awkward cases on purpose:
//   • an analyte with NO readings                      (Ferritin)
//   • an analyte with exactly ONE reading              (TSH)
//   • two goals on the SAME family                     (two LDL goals)
//   • a family reached through a SYNONYM, so the SQL `biomarker_family()` function
//     is what matches the rows rather than a name compare (goal on "Hemoglobin A1c",
//     rows stored as "HbA1c"; a second goal spelled "A1c")
//   • an analyte whose stored rows carry NO canonical_name, which the family key
//     still resolves through `name` (the reason this can't be getAllBiomarkerSeries)

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  getBiomarkerSeries,
  getBiomarkerSeriesFor,
} from "@/lib/queries/medical";
import { biomarkerPlot, biomarkerPlots } from "@/lib/queries/biomarker-plot";
import {
  getOutcomeGoalProgressMap,
  getOutcomeGoals,
} from "@/lib/queries/training/outcome-goals";
import { buildGoalPacingFindings } from "@/lib/rule-findings";
import { today } from "@/lib/db";

// Every analyte the fixture asks about, including the two with no rows behind them.
const TARGETS = [
  "LDL Cholesterol",
  "Hemoglobin A1c",
  "A1c",
  "Thyroid-Stimulating Hormone (TSH)",
  "Ferritin",
  "Lab Coined Marker",
];

let profileId: number;
let todayStr: string;

function insertReading(
  date: string,
  name: string,
  canonical: string | null,
  value: number,
  unit: string
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  ).run(profileId, date, name, String(value), unit, canonical, value);
}

function insertGoal(fields: {
  title: string;
  biomarker: string;
  target: number;
  unit: string;
  direction: "below" | "above";
  baseline: number | null;
  targetDate: string | null;
  createdAt: string;
}) {
  return Number(
    db
      .prepare(
        `INSERT INTO goals
           (profile_id, title, target_value, unit, target_date, status, created_at,
            baseline_value, biomarker_name, target_direction)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        fields.title,
        fields.target,
        fields.unit,
        fields.targetDate,
        fields.createdAt,
        fields.baseline,
        fields.biomarker,
        fields.direction
      ).lastInsertRowid
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("plot-batch")
      .lastInsertRowid
  );
  todayStr = today(profileId);
  // Demographics: the reads the batch hoists out of the per-analyte loop. Present so
  // the sex/age-banded reference range is actually resolved, not skipped.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
  ).run(profileId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1980-02-29')`
  ).run(profileId);

  // LDL: several readings, drifting the WRONG way so the pacing finding has
  // something to say.
  insertReading(
    "2025-01-10",
    "LDL Cholesterol",
    "LDL Cholesterol",
    120,
    "mg/dL"
  );
  insertReading(
    "2025-04-10",
    "LDL Cholesterol",
    "LDL Cholesterol",
    134,
    "mg/dL"
  );
  insertReading(
    "2025-07-10",
    "LDL Cholesterol",
    "LDL Cholesterol",
    148,
    "mg/dL"
  );
  // A duplicate of the last draw from a second document — the read-layer de-dup must
  // collapse it identically in both the single and the batched query.
  insertReading(
    "2025-07-10",
    "LDL Cholesterol",
    "LDL Cholesterol",
    148,
    "mg/dL"
  );

  // A1c stored under a SYNONYM spelling: only biomarker_family() links these rows to
  // a goal that names "Hemoglobin A1c".
  insertReading("2025-02-01", "HbA1c", "HbA1c", 5.9, "%");
  insertReading("2025-06-01", "HbA1c", "HbA1c", 6.2, "%");

  // Exactly one reading.
  insertReading(
    "2025-05-05",
    "TSH",
    "Thyroid-Stimulating Hormone (TSH)",
    2.4,
    "uIU/mL"
  );

  // A freeform name with NO canonical_name at all: the family key resolves it
  // through `name`, so it belongs to this series even though the bulk
  // canonical-name read would drop it.
  insertReading("2025-03-03", "Lab Coined Marker", null, 42, "ng/mL");

  // Ferritin deliberately has no rows.

  insertGoal({
    title: "LDL under 100",
    biomarker: "LDL Cholesterol",
    target: 100,
    unit: "mg/dL",
    direction: "below",
    baseline: 120,
    targetDate: "2025-12-31",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "LDL under 90",
    biomarker: "LDL Cholesterol",
    target: 90,
    unit: "mg/dL",
    direction: "below",
    baseline: 120,
    targetDate: "2026-06-30",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "A1c under 5.7",
    biomarker: "Hemoglobin A1c",
    target: 5.7,
    unit: "%",
    direction: "below",
    baseline: 5.9,
    targetDate: "2025-12-31",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "A1c under 5.5 (synonym spelling)",
    biomarker: "A1c",
    target: 5.5,
    unit: "%",
    direction: "below",
    baseline: 5.9,
    targetDate: "2026-03-31",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "TSH under 2",
    biomarker: "Thyroid-Stimulating Hormone (TSH)",
    target: 2,
    unit: "uIU/mL",
    direction: "below",
    baseline: 2.4,
    targetDate: "2026-01-31",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "Ferritin over 50",
    biomarker: "Ferritin",
    target: 50,
    unit: "ng/mL",
    direction: "above",
    baseline: null,
    targetDate: "2026-01-31",
    createdAt: "2025-01-01 00:00:00",
  });
  insertGoal({
    title: "Coined marker over 60",
    biomarker: "Lab Coined Marker",
    target: 60,
    unit: "ng/mL",
    direction: "above",
    baseline: 42,
    targetDate: "2026-01-31",
    createdAt: "2025-01-01 00:00:00",
  });
});

describe("batched biomarker series", () => {
  it("returns each analyte exactly what the per-analyte read returns", () => {
    const batched = getBiomarkerSeriesFor(profileId, TARGETS);
    for (const name of TARGETS) {
      expect(batched.get(name)).toEqual(getBiomarkerSeries(profileId, name));
    }
  });

  it("carries no leftover grouping column into the returned rows", () => {
    const rows = getBiomarkerSeriesFor(profileId, TARGETS).get(
      "LDL Cholesterol"
    )!;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(
        Object.keys(getBiomarkerSeries(profileId, "LDL Cholesterol")[0])
      );
    }
  });

  it("collapses two spellings of one family onto that family's series", () => {
    const batched = getBiomarkerSeriesFor(profileId, TARGETS);
    expect(batched.get("A1c")).toEqual(batched.get("Hemoglobin A1c"));
    // The rows are the SYNONYM-named ones — matched by biomarker_family(), not by
    // any comparison against the requested spelling.
    expect(batched.get("Hemoglobin A1c")!.map((r) => r.name)).toEqual([
      "HbA1c",
      "HbA1c",
    ]);
  });

  it("keeps a reading with no canonical_name in its own series", () => {
    const rows = getBiomarkerSeriesFor(profileId, TARGETS).get(
      "Lab Coined Marker"
    )!;
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBeNull();
  });

  it("returns an empty series for an analyte with no readings", () => {
    expect(getBiomarkerSeriesFor(profileId, TARGETS).get("Ferritin")).toEqual(
      []
    );
  });

  it("is empty for an empty request", () => {
    expect(getBiomarkerSeriesFor(profileId, []).size).toBe(0);
  });
});

describe("batched biomarker plots", () => {
  it("matches the one-at-a-time plot for every analyte", () => {
    const batched = biomarkerPlots(profileId, TARGETS);
    for (const name of TARGETS) {
      // biomarkerPlots with a single name takes the single-family short-circuit —
      // the pre-#1961 read path — so this is batched vs. unbatched, not a no-op.
      expect(batched.get(name)).toEqual(biomarkerPlot(profileId, name));
    }
  });

  it("plots the deduped family series in its canonical unit", () => {
    const plot = biomarkerPlots(profileId, TARGETS).get("LDL Cholesterol")!;
    expect(plot.unit).toBe("mg/dL");
    // Four physical rows, one of them a cross-document duplicate of the last draw.
    expect(plot.points).toEqual([
      { date: "2025-01-10", value: 120 },
      { date: "2025-04-10", value: 134 },
      { date: "2025-07-10", value: 148 },
    ]);
  });

  it("gives a single-reading analyte a one-point plot", () => {
    const plot = biomarkerPlots(profileId, TARGETS).get(
      "Thyroid-Stimulating Hormone (TSH)"
    )!;
    expect(plot.points).toHaveLength(1);
  });

  it("returns null for an analyte with no readings", () => {
    expect(biomarkerPlots(profileId, TARGETS).get("Ferritin")).toBeNull();
  });

  it("does not read demographics when nothing in the batch has readings", () => {
    // Nothing to assert on the wire here beyond the answer itself: an all-empty
    // batch must still return one null per name.
    const plots = biomarkerPlots(profileId, ["Ferritin", "Homocysteine"]);
    expect([...plots.values()]).toEqual([null, null]);
  });
});

describe("the two hot paths", () => {
  it("gives every goal the same progress it gets computed alone", () => {
    const goals = getOutcomeGoals(profileId);
    const together = getOutcomeGoalProgressMap(profileId, goals);
    for (const g of goals) {
      // One goal at a time is one requested analyte, i.e. the unbatched read.
      const alone = getOutcomeGoalProgressMap(profileId, [g]);
      expect(together.get(g.id)).toEqual(alone.get(g.id));
    }
    // And the numbers themselves are the plotted ones, not a coincidence of two
    // equally-broken paths.
    const ldl = goals.find((g) => g.title === "LDL under 100")!;
    expect(together.get(ldl.id)).toMatchObject({
      current: 148,
      target: 100,
      unit: "mg/dL",
      done: false,
      asOf: "2025-07-10",
      unavailable: null,
    });
    const ferritin = goals.find((g) => g.title === "Ferritin over 50")!;
    expect(together.get(ferritin.id)).toMatchObject({
      unavailable: "no-readings",
      asOf: null,
    });
  });

  it("paces each biomarker goal off its own plot", () => {
    const findings = buildGoalPacingFindings(profileId, todayStr);
    const titles = findings.map((f) => f.title);
    // LDL is drifting UP against two "below" targets, so both are off pace; the
    // dedupe keys are per goal, so both survive.
    expect(titles).toContain("“LDL under 100” is off pace");
    expect(titles).toContain("“LDL under 90” is off pace");
    // Ferritin has no result at all — a goal that has never been drawn since it was
    // created can't be off pace.
    expect(titles).not.toContain("“Ferritin over 50” is off pace");
    // Every finding carries the shared goal-pace coaching namespace.
    for (const f of findings) {
      expect(f.domain).toBe("goal-pace");
      expect(f.dedupeKey.startsWith("goal-pace:")).toBe(true);
    }
  });
});
