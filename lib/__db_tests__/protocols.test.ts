// DB INTEGRATION TIER — Protocols (issue #161).
//   1. The `protocols` table exists after migrate() (migration 010) with its
//      columns/index, and a fresh vs. replayed schema is a no-op.
//   2. getProtocols/getProtocol are profile-scoped (no cross-profile bleed) and
//      ordered (ongoing first).
//   3. The comparison seam gathers a real biomarker series and computes a shift.
// The static source scan can't see across the query helpers; this is the dynamic
// guard.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  getProtocols,
  getProtocol,
  getProtocolComparison,
  getProtocolWindows,
  getProtocolWindowsForOutcome,
  getActiveProtocolSummaries,
  getProtocolIntakeItem,
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
    // No practice link → null adherence.
    expect(out[0].adherence).toBeNull();
    expect(out[0].href).toBe(`/protocols/${getProtocols(profile)[0].id}`);
  });
});

describe("intake-item link delete null-out (issue #660)", () => {
  it("nulls protocols.intake_item_id when the linked item is deleted", () => {
    const profile = newProfile("Proto Intake");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
           VALUES (?, 'Creatine', 1, 'supplement', 'daily', 'low')`
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
