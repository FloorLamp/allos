// DB INTEGRATION TIER — Protocols (issue #161).
//   1. The `protocols` table exists after migrate() (migration 010) with its
//      columns/index, and a fresh vs. replayed schema is a no-op.
//   2. getProtocols/getProtocol are profile-scoped (no cross-profile bleed) and
//      ordered (ongoing first).
//   3. The comparison seam gathers a real biomarker series and computes a shift.
// The static source scan can't see across the query helpers; this is the dynamic
// guard.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getProtocols,
  getProtocol,
  getProtocolComparison,
  getProtocolOutcomePickerData,
  getProtocolWindows,
  getProtocolWindowsForOutcome,
  getActiveProtocolSummaries,
  getFrequencyTargetProgress,
  getProtocolIntakeItem,
  getProtocolOutcomeOptions,
  resolveOutcomeSeries,
  situationUsedByOtherProtocol,
} from "@/lib/queries";
import { captureDelete } from "@/lib/undo-delete-db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertProtocol(
  profileId: number,
  opts: {
    name: string;
    start: string;
    end?: string | null;
    keys?: string[];
    situation?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, outcome_keys, situation)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.name,
        opts.start,
        opts.end ?? null,
        JSON.stringify(opts.keys ?? []),
        opts.situation ?? null
      ).lastInsertRowid
  );
}

describe("protocols schema", () => {
  it("migration 010 created the protocols table with its columns", () => {
    const cols = (
      db.prepare("PRAGMA table_info(protocols)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "profile_id",
        "name",
        "start_date",
        "end_date",
        "notes",
        "outcome_keys",
        "situation",
        "created_at",
      ])
    );
    const idx = db.prepare("PRAGMA index_list(protocols)").all() as {
      name: string;
    }[];
    expect(idx.some((i) => i.name === "idx_protocols_profile")).toBe(true);
  });
});

describe("protocols reads", () => {
  let profileA: number;
  let profileB: number;

  beforeAll(() => {
    profileA = newProfile("Proto A");
    profileB = newProfile("Proto B");
    // A: one ended, one ongoing (ongoing must sort first).
    insertProtocol(profileA, {
      name: "A ended",
      start: "2026-01-01",
      end: "2026-02-01",
      keys: ["metric:weight"],
    });
    insertProtocol(profileA, {
      name: "A ongoing",
      start: "2026-03-01",
      end: null,
      keys: ["metric:resting_hr"],
      situation: "Creatine loading",
    });
    insertProtocol(profileB, { name: "B only", start: "2026-01-15" });
  });

  it("is profile-scoped and orders ongoing first", () => {
    const a = getProtocols(profileA);
    expect(a.map((p) => p.name)).toEqual(["A ongoing", "A ended"]);
    expect(a.every((p) => p.name.startsWith("A"))).toBe(true);
    expect(a[0].outcomeKeys).toEqual(["metric:resting_hr"]);
    expect(a[0].end_date).toBeNull();

    const b = getProtocols(profileB);
    expect(b.map((p) => p.name)).toEqual(["B only"]);
  });

  it("getProtocol 404s across profiles", () => {
    const a = getProtocols(profileA)[0];
    expect(getProtocol(profileA, a.id)?.name).toBe("A ongoing");
    expect(getProtocol(profileB, a.id)).toBeNull();
  });

  it("situationUsedByOtherProtocol sees only OTHER ongoing protocols", () => {
    const a = getProtocols(profileA).find((p) => p.name === "A ongoing")!;
    // No other ongoing protocol in A uses this label.
    expect(
      situationUsedByOtherProtocol(profileA, "Creatine loading", a.id)
    ).toBe(false);
    const other = insertProtocol(profileA, {
      name: "A other ongoing",
      start: "2026-04-01",
      situation: "Creatine loading",
    });
    expect(
      situationUsedByOtherProtocol(profileA, "Creatine loading", a.id)
    ).toBe(true);
    db.prepare("DELETE FROM protocols WHERE id = ?").run(other);
  });
});

describe("protocol comparison seam", () => {
  it("gathers a biomarker series and computes a before/during shift", () => {
    const profile = newProfile("Proto Compare");
    // LDL: 130 before the protocol, 110 during.
    const insLab = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value_num, unit)
       VALUES (?, ?, 'lab', 'LDL Cholesterol', 'LDL Cholesterol', ?, 'mg/dL')`
    );
    insLab.run(profile, "2026-04-15", 130);
    insLab.run(profile, "2026-05-20", 110);
    const id = insertProtocol(profile, {
      name: "Statin trial",
      start: "2026-05-01",
      end: "2026-06-25",
      keys: ["biomarker:LDL Cholesterol"],
    });
    const protocol = getProtocol(profile, id)!;
    const cmp = getProtocolComparison(profile, protocol, "2026-06-25", "kg");
    const o = cmp.outcomes.find((x) => x.key === "biomarker:LDL Cholesterol")!;
    expect(o.baseline.mean).toBe(130); // nearest draw before start
    expect(o.intervention.mean).toBe(110);
    expect(o.meanDelta).toBe(-20);
    expect(o.betterness).toBe("better"); // LDL is lower_better

    const picker = getProtocolOutcomePickerData(
      profile,
      protocol,
      "2026-06-25",
      "kg"
    );
    expect(
      picker.options.find(
        (option) => option.key === "biomarker:LDL Cholesterol"
      )?.preview
    ).toMatchObject({
      beforeMean: 130,
      duringMean: 110,
      meanDelta: -20,
      unit: "mg/dL",
      beforeN: 1,
      duringN: 1,
    });
    expect(picker.comparison.outcomes).toHaveLength(1);
    expect(picker.comparison.outcomes[0].meanDelta).toBe(-20);
  });

  it("keeps a selected biomarker editable after its source reading is deleted", () => {
    const profile = newProfile("Proto Historical Outcome");
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value_num, unit)
       VALUES (?, '2026-04-15', 'lab', 'Ferritin', 'Ferritin', 80, 'ng/mL')`
    ).run(profile);
    const id = insertProtocol(profile, {
      name: "Historical marker",
      start: "2026-05-01",
      keys: ["biomarker:Ferritin"],
    });
    db.prepare(
      `DELETE FROM medical_records
        WHERE profile_id = ? AND canonical_name = 'Ferritin'`
    ).run(profile);

    const picker = getProtocolOutcomePickerData(
      profile,
      getProtocol(profile, id)!,
      "2026-06-25",
      "kg"
    );
    expect(picker.options.map((option) => option.key)).toContain(
      "biomarker:Ferritin"
    );
    expect(picker.comparison.outcomes.map((outcome) => outcome.key)).toContain(
      "biomarker:Ferritin"
    );
  });
});

describe("protocol outcome options (#1586)", () => {
  it("inherits shared biomarker relevance order within its tracked-only scope", () => {
    const profile = newProfile("Proto Ranked Outcomes");
    const insert = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value_num, unit, flag)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
    );
    insert.run(
      profile,
      "2026-01-01",
      "Hemoglobin A1c",
      "Hemoglobin A1c",
      5.7,
      "%",
      "normal"
    );
    insert.run(
      profile,
      "2026-06-20",
      "LDL Cholesterol",
      "LDL Cholesterol",
      150,
      "mg/dL",
      "high"
    );
    insert.run(
      profile,
      "2026-06-20",
      "Albumin",
      "Albumin",
      4.4,
      "g/dL",
      "normal"
    );

    const biomarkerKeys = getProtocolOutcomeOptions(profile, "2026-06-25")
      .filter((option) => option.key.startsWith("biomarker:"))
      .map((option) => option.key);

    expect(biomarkerKeys.slice(0, 3)).toEqual([
      "biomarker:Hemoglobin A1c",
      "biomarker:LDL Cholesterol",
      "biomarker:Albumin",
    ]);
  });

  it("includes a computed derived index and resolves its virtual series", () => {
    const profile = newProfile("Proto Derived Outcomes");
    const insert = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value_num, unit)
       VALUES (?, '2026-05-01', 'lab', ?, ?, ?, 'mg/dL')`
    );
    insert.run(profile, "Total Cholesterol", "Total Cholesterol", 210);
    insert.run(profile, "HDL Cholesterol", "HDL Cholesterol", 50);

    const options = getProtocolOutcomeOptions(profile, "2026-06-25");
    expect(options.map((option) => option.key)).toContain(
      "biomarker:Non-HDL Cholesterol"
    );
    expect(
      resolveOutcomeSeries(profile, "biomarker:Non-HDL Cholesterol", "kg")
        ?.samples
    ).toEqual([{ date: "2026-05-01", value: 160 }]);
  });

  it("offers one logical option and merges legacy body-metric readings", () => {
    const profile = newProfile("Proto Deduped Outcomes");
    db.prepare(
      `INSERT INTO body_metrics
         (profile_id, date, resting_hr, source)
       VALUES (?, '2026-05-01', 58, 'manual')`
    ).run(profile);
    const insert = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value_num, unit)
       VALUES (?, ?, 'lab', ?, ?, ?, ?)`
    );
    insert.run(
      profile,
      "2026-04-01",
      "Resting Heart Rate",
      "Resting Heart Rate",
      62,
      "bpm"
    );
    // The authoritative body_metrics value wins on an overlapping date.
    insert.run(
      profile,
      "2026-05-01",
      "Resting Heart Rate",
      "Resting Heart Rate",
      70,
      "bpm"
    );
    insert.run(
      profile,
      "2026-05-01",
      "Body Fat Percentage",
      "Body Fat Percentage",
      20,
      "%"
    );
    insert.run(profile, "2026-05-01", "PhenoAge", "PhenoAge", 44, "yrs");

    const optionKeys = getProtocolOutcomeOptions(profile, "2026-06-25").map(
      (option) => option.key
    );
    expect(optionKeys).toEqual(
      expect.arrayContaining([
        "metric:resting_hr",
        "metric:body_fat",
        "index:phenoage",
      ])
    );
    expect(optionKeys).not.toEqual(
      expect.arrayContaining([
        "biomarker:Resting Heart Rate",
        "biomarker:Body Fat Percentage",
        "biomarker:PhenoAge",
      ])
    );

    expect(
      resolveOutcomeSeries(profile, "biomarker:Resting Heart Rate", "kg")
    ).toMatchObject({
      key: "metric:resting_hr",
      samples: [
        { date: "2026-04-01", value: 62 },
        { date: "2026-05-01", value: 58 },
      ],
    });
    expect(
      resolveOutcomeSeries(profile, "biomarker:PhenoAge", "kg")
    ).toMatchObject({
      key: "index:phenoage",
      samples: [{ date: "2026-05-01", value: 44 }],
    });
  });
});

describe("protocol chart windows (issue #660)", () => {
  it("returns every protocol as a window and narrows to a targeting outcome", () => {
    const profile = newProfile("Proto Windows");
    insertProtocol(profile, {
      name: "Creatine",
      start: "2026-03-01",
      end: null,
      keys: ["metric:weight"],
    });
    insertProtocol(profile, {
      name: "Statin",
      start: "2026-01-01",
      end: "2026-02-01",
      keys: ["biomarker:LDL Cholesterol"],
    });

    const all = getProtocolWindows(profile);
    expect(all.map((w) => w.name).sort()).toEqual(["Creatine", "Statin"]);
    const ongoing = all.find((w) => w.name === "Creatine")!;
    expect(ongoing.endDate).toBeNull();

    // Only the protocol declaring the LDL outcome shows on the LDL chart.
    const ldl = getProtocolWindowsForOutcome(
      profile,
      "biomarker:LDL Cholesterol"
    );
    expect(ldl.map((w) => w.name)).toEqual(["Statin"]);
    expect(getProtocolWindowsForOutcome(profile, "metric:weight")).toHaveLength(
      1
    );
  });

  it("normalizes legacy stored aliases without requiring a data migration", () => {
    const profile = newProfile("Proto Legacy Outcome Keys");
    const id = insertProtocol(profile, {
      name: "Legacy HR trial",
      start: "2026-03-01",
      keys: ["biomarker:Resting Heart Rate", "metric:resting_hr"],
    });

    expect(getProtocol(profile, id)?.outcomeKeys).toEqual([
      "metric:resting_hr",
    ]);
    expect(
      getProtocolWindowsForOutcome(profile, "biomarker:Resting Heart Rate").map(
        (window) => window.name
      )
    ).toEqual(["Legacy HR trial"]);
  });
});

describe("getActiveProtocolSummaries (issue #660)", () => {
  it("summarizes ongoing protocols only, with days elapsed + the primary outcome", () => {
    const profile = newProfile("Proto Widget");
    insertProtocol(profile, {
      name: "Ongoing creatine",
      start: "2026-05-01",
      end: null,
      keys: ["metric:weight"],
    });
    insertProtocol(profile, {
      name: "Ended block",
      start: "2026-01-01",
      end: "2026-02-01",
      keys: ["metric:weight"],
    });

    const out = getActiveProtocolSummaries(profile, "2026-05-10", "kg");
    // Only the ongoing one.
    expect(out.map((p) => p.name)).toEqual(["Ongoing creatine"]);
    // Inclusive elapsed days: May 1 → May 10 = 10 days in.
    expect(out[0].daysElapsed).toBe(10);
    expect(out[0].primaryOutcome?.label).toBe("Body weight");
    // No practice link → null adherence. The widget renders no verdict at all for
    // that, which is what the detail page now also does (#2008): with no progress
    // row there is nothing to be on pace WITH.
    expect(out[0].adherence).toBeNull();
    expect(out[0].href).toBe(`/protocols/${getProtocols(profile)[0].id}`);
  });

  it("carries the PACED weekly verdict, not just met/not-met (#2008)", () => {
    const profile = newProfile("Proto Pace");
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
           VALUES (?, 'practice', 'Cold plunge', 'cold plunge', 3, 5)`
        )
        .run(profile).lastInsertRowid
    );
    const todayStr = today(profile);
    db.prepare(
      `INSERT INTO protocols
         (profile_id, name, start_date, outcome_keys, frequency_target_id, owns_frequency_target)
       VALUES (?, 'Plunge trial', ?, '[]', ?, 1)`
    ).run(profile, todayStr, targetId);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, 'Cold plunge', ?)`
    ).run(profile, todayStr);

    const progress = getFrequencyTargetProgress(profile).find(
      (p) => p.target.id === targetId
    )!;
    const summary = getActiveProtocolSummaries(profile, todayStr, "kg")[0];
    expect(summary.adherence).not.toBeNull();
    // The widget's verdict is the SAME value the detail page and the wellness card
    // render — one computation, copied through, never re-derived from `met`.
    expect(summary.adherence!.pace).toBe(progress.pace);
    expect(summary.adherence!.count).toBe(progress.count);
    expect(summary.adherence!.atCeiling).toBe(progress.atCeiling);
    // The range's ceiling and the practice's counting noun ride along, so the
    // shared component can render "N days this week · Target 3-5x/week".
    expect(summary.adherence!.perWeekMax).toBe(5);
    expect(summary.adherence!.noun).toBe("day");
  });

  // #2204 (owner ruling): the dashboard widget mounts the SAME ProtocolLogButton the
  // detail page does, so it needs the same prefill or its one-tap would be the last
  // practice log in the app that discards a duration it never showed.
  it("carries the practice's duration prefill for the widget's inline stepper", () => {
    const profile = newProfile("Proto Duration");
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
           VALUES (?, 'practice', 'Sauna', 'sauna', 3, NULL)`
        )
        .run(profile).lastInsertRowid
    );
    const todayStr = today(profile);
    db.prepare(
      `INSERT INTO protocols
         (profile_id, name, start_date, outcome_keys, frequency_target_id, owns_frequency_target)
       VALUES (?, 'Sauna trial', ?, '[]', ?, 1)`
    ).run(profile, todayStr, targetId);

    // No history yet: blank is a real answer, and the widget must not invent one.
    expect(
      getActiveProtocolSummaries(profile, todayStr, "kg")[0]
        .practicePreviousDurationMin
    ).toBeNull();

    const log = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min)
       VALUES (?, ?, ?, ?, ?)`
    );
    log.run(profile, "Sauna", shiftDateStr(todayStr, -1), "07:00", 15);
    log.run(profile, "sauna", todayStr, "07:30", 20);
    // The LAST logged session wins, folded across the identity's spellings — the same
    // pure resolution every other practice surface reads.
    expect(
      getActiveProtocolSummaries(profile, todayStr, "kg")[0]
        .practicePreviousDurationMin
    ).toBe(20);

    // A session logged WITHOUT one prefills blank again: clearing the stepper is a
    // decision the next prefill honours rather than reaching further back.
    log.run(profile, "Sauna", todayStr, "19:00", null);
    expect(
      getActiveProtocolSummaries(profile, todayStr, "kg")[0]
        .practicePreviousDurationMin
    ).toBeNull();
  });

  it("has no duration prefill for a non-practice protocol scope", () => {
    const profile = newProfile("Proto Duration Food");
    insertProtocol(profile, {
      name: "Veg push",
      start: "2026-05-01",
      end: null,
      keys: [],
    });
    // The activity/food actions open their own full forms, which have always asked
    // for what they record — there is no one-tap duration to prefill.
    expect(
      getActiveProtocolSummaries(profile, "2026-05-10", "kg")[0]
        .practicePreviousDurationMin
    ).toBeNull();
  });
});

describe("intake-item link delete null-out (issue #660)", () => {
  it("nulls protocols.intake_item_id when the linked item is deleted", () => {
    const profile = newProfile("Proto Intake");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Creatine', 1, 'supplement', 'daily', 'should')`
        )
        .run(profile).lastInsertRowid
    );
    const protoId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date, intake_item_id)
           VALUES (?, 'Creatine trial', '2026-05-01', ?)`
        )
        .run(profile, itemId).lastInsertRowid
    );
    expect(getProtocol(profile, protoId)!.intake_item_id).toBe(itemId);
    expect(getProtocolIntakeItem(profile, itemId)?.name).toBe("Creatine");

    // Deleting the intake item must NOT throw on the protocols FK, and must null
    // the protocol's intervention link (row-ops null-out rule).
    captureDelete("intake-item", profile, itemId);
    expect(getProtocol(profile, protoId)!.intake_item_id).toBeNull();
  });
});
