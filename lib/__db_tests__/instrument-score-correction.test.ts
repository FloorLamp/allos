// DB INTEGRATION TIER (issue #1396) — correcting and removing a screening score.
//
// The bug this pins is a SAFETY bug, not a missing nicety: a screening score used to
// be create-only, and a severe total raises the NON-DISMISSIBLE crisis line. So a
// fat-fingered outside total — a GAD-7 of 21 typed for 12 — permanently tripped a
// banner with no recovery path. The banner and the History list read the SAME
// computation (getInstrumentStates over the stored rows), so this tier is the one
// that can see the whole loop: record → banner up → correct → banner DOWN.
//
// Also pinned here: the undo capture brings the item ANSWERS back. PHQ-9 item 9 is
// the self-harm item the crisis gate reads, so an undo that restored the total but
// dropped the answers would silently downgrade a restored reading's safety signal.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  recordInstrumentScore,
  updateInstrumentScore,
  deleteInstrumentScore,
  getInstrumentReadings,
  getInstrumentStates,
  getInstrumentScoreInstrument,
} from "@/lib/instrument-records";
import { restoreDeletedRow } from "@/lib/undo-delete-db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function escalating(profileId: number): string[] {
  return getInstrumentStates(profileId)
    .filter((s) => s.crisis?.escalate && s.latest)
    .map((s) => s.instrument);
}

describe("correcting a mis-entered score releases the crisis line", () => {
  it("a fat-fingered severe GAD-7 raises the banner; correcting the total below threshold releases it", () => {
    const p = newProfile("gad-typo");
    const td = today(p);
    // 21 is GAD-7's maximum — the "typed 21, meant 12" case from the issue.
    const id = recordInstrumentScore(p, {
      instrument: "GAD-7",
      date: td,
      total: 21,
    });
    expect(escalating(p)).toContain("GAD-7");

    const outcome = updateInstrumentScore(p, id, { date: td, total: 12 });
    expect(outcome).toEqual({ kind: "updated" });

    // The banner reads the SAME computation the list does, so the correction IS the
    // recompute — no invalidation step, and no way for the two to disagree.
    expect(escalating(p)).toEqual([]);
    const readings = getInstrumentReadings(p);
    expect(readings).toHaveLength(1);
    expect(readings[0].total).toBe(12);
  });

  it("removing the mis-entered score releases the banner too, and the reading is gone", () => {
    const p = newProfile("gad-delete");
    const td = today(p);
    const id = recordInstrumentScore(p, {
      instrument: "GAD-7",
      date: td,
      total: 21,
    });
    expect(escalating(p)).toContain("GAD-7");

    const outcome = deleteInstrumentScore(p, id);
    expect(outcome.kind).toBe("deleted");
    expect(escalating(p)).toEqual([]);
    expect(getInstrumentReadings(p)).toEqual([]);
  });

  it("an older severe score still escalates after the newest one is removed (latest-wins, not blanket-clear)", () => {
    const p = newProfile("gad-two");
    const older = recordInstrumentScore(p, {
      instrument: "GAD-7",
      date: "2020-03-04",
      total: 19,
    });
    const newer = recordInstrumentScore(p, {
      instrument: "GAD-7",
      date: "2020-05-06",
      total: 3,
    });
    expect(escalating(p)).toEqual([]); // latest is mild

    deleteInstrumentScore(p, newer);
    // The older severe reading is now the latest — the banner must come back.
    expect(escalating(p)).toContain("GAD-7");
    expect(getInstrumentReadings(p).map((r) => r.id)).toEqual([older]);
  });
});

describe("editing an administered score", () => {
  it("refuses a TOTAL change on an item-by-item administration (the answers are the source of truth)", () => {
    const p = newProfile("phq-administered");
    const td = today(p);
    const id = recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 22,
      // Nine answered items — the shape an in-app administration produces.
      answers: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        itemIndex: i,
        answer: 2,
      })),
    });
    const refusal = updateInstrumentScore(p, id, { date: td, total: 4 });
    expect(refusal).toEqual({ kind: "answers-derived", itemCount: 9 });
    expect(getInstrumentReadings(p)[0].total).toBe(22);
  });

  it("still allows a DATE-only correction on an administered score", () => {
    const p = newProfile("phq-date-only");
    const td = today(p);
    const id = recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 6,
      answers: [{ itemIndex: 0, answer: 1 }],
    });
    expect(
      updateInstrumentScore(p, id, { date: "2019-02-03", total: 6 })
    ).toEqual({ kind: "updated" });
    expect(getInstrumentReadings(p)[0].date).toBe("2019-02-03");
  });
});

describe("scoping and identity guards", () => {
  it("another profile's score is not found, and is not touched", () => {
    const owner = newProfile("owner");
    const other = newProfile("other");
    const td = today(owner);
    const id = recordInstrumentScore(owner, {
      instrument: "PHQ-9",
      date: td,
      total: 20,
    });

    expect(getInstrumentScoreInstrument(other, id)).toBeNull();
    expect(updateInstrumentScore(other, id, { date: td, total: 1 })).toEqual({
      kind: "not-found",
    });
    expect(deleteInstrumentScore(other, id)).toEqual({ kind: "not-found" });
    expect(getInstrumentReadings(owner)[0].total).toBe(20);
  });

  it("refuses to touch a NON-instrument medical_records row (a lab reading has its own delete)", () => {
    const p = newProfile("lab-guard");
    const labId = Number(
      db
        .prepare(
          `INSERT INTO medical_records (date, category, name, value, value_num, canonical_name, profile_id)
           VALUES ('2020-01-02', 'lab', 'Ferritin', '80', 80, 'Ferritin', ?)`
        )
        .run(p).lastInsertRowid
    );
    expect(getInstrumentScoreInstrument(p, labId)).toBeNull();
    expect(deleteInstrumentScore(p, labId)).toEqual({ kind: "not-found" });
    const still = db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE id = ?")
      .get(labId) as { n: number };
    expect(still.n).toBe(1);
  });

  it("handles a substance-use instrument through the same core", () => {
    const p = newProfile("auditc");
    expect(
      getInstrumentScoreInstrument(
        p,
        recordInstrumentScore(p, {
          instrument: "AUDIT-C",
          date: "2020-06-07",
          total: 7,
        })
      )
    ).toBe("AUDIT-C");
  });
});

describe("undo restores the score AND its item answers", () => {
  it("a deleted PHQ-9 with a positive item 9 comes back still escalating", () => {
    const p = newProfile("undo-item9");
    const td = today(p);
    // A sub-severe TOTAL with a positive self-harm item: the escalation rests
    // ENTIRELY on the stored answers, so an undo that lost them would silently
    // downgrade the restored reading.
    const answers = [0, 0, 0, 0, 0, 0, 0, 0, 2].map((a, i) => ({
      itemIndex: i,
      answer: a,
    }));
    const id = recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 2,
      answers,
    });
    expect(escalating(p)).toContain("PHQ-9");

    const outcome = deleteInstrumentScore(p, id);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted" || outcome.undoId == null)
      throw new Error("expected an undo token");
    expect(escalating(p)).toEqual([]);

    expect(restoreDeletedRow(p, outcome.undoId)).toBe(true);
    const restored = getInstrumentReadings(p);
    expect(restored).toHaveLength(1);
    expect(restored[0].selfHarmAnswer).toBe(2);
    expect(escalating(p)).toContain("PHQ-9");
  });
});
