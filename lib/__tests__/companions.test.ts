import { describe, it, expect } from "vitest";
import {
  buildCompanionMap,
  biasByCompanions,
  type CompanionRow,
  type CompanionMap,
} from "@/lib/companions";

const TODAY = "2026-07-10";

// Convenience: one activity's worth of rows (same id/date, many exercises).
const activity = (
  activityId: number,
  date: string,
  ...exercises: string[]
): CompanionRow[] =>
  exercises.map((exercise) => ({ activityId, date, exercise }));

describe("buildCompanionMap", () => {
  it("pairs exercises logged in the same activity, both directions", () => {
    const map = buildCompanionMap(
      activity(1, TODAY, "Bench Press", "Row"),
      TODAY
    );
    expect(map["bench press"]).toEqual(["Row"]);
    expect(map["row"]).toEqual(["Bench Press"]);
  });

  it("never lists an exercise as its own companion", () => {
    // Same exercise logged twice in one activity (e.g. two blocks) — no self-pair.
    const map = buildCompanionMap(
      activity(1, TODAY, "Bench Press", "Bench Press"),
      TODAY
    );
    expect(map["bench press"]).toBeUndefined();
  });

  it("counts a pair once per activity, not once per set", () => {
    // Rows are already distinct (activity, exercise) from the SQL GROUP BY; the
    // builder de-dupes defensively so set multiplicity can't inflate a pairing.
    const rows = [
      ...activity(1, TODAY, "Bench Press", "Bench Press", "Row"),
      ...activity(2, TODAY, "Bench Press", "Squat"),
    ];
    const map = buildCompanionMap(rows, TODAY);
    // Bench co-occurs with Row once (act 1) and Squat once (act 2) — a tie, so
    // both appear; alphabetical tiebreak orders Row before Squat.
    expect(map["bench press"]).toEqual(["Row", "Squat"]);
  });

  it("collapses variant names to their base lift", () => {
    const map = buildCompanionMap(
      activity(1, TODAY, "Dumbbell Curl", "Barbell Row"),
      TODAY
    );
    expect(map["curl"]).toEqual(["Row"]);
    expect(map["row"]).toEqual(["Curl"]);
  });

  it("decays stale pairings below fresh ones", () => {
    // Bench+Row logged recently (3 activities), Bench+Squat long ago (5). The
    // recent pairing should rank first despite fewer occurrences.
    const rows = [
      ...activity(1, TODAY, "Bench Press", "Row"),
      ...activity(2, "2026-07-05", "Bench Press", "Row"),
      ...activity(3, "2026-07-01", "Bench Press", "Row"),
      ...activity(4, "2025-09-01", "Bench Press", "Squat"),
      ...activity(5, "2025-08-25", "Bench Press", "Squat"),
      ...activity(6, "2025-08-18", "Bench Press", "Squat"),
      ...activity(7, "2025-08-11", "Bench Press", "Squat"),
      ...activity(8, "2025-08-04", "Bench Press", "Squat"),
    ];
    const map = buildCompanionMap(rows, TODAY);
    expect(map["bench press"][0]).toBe("Row");
  });

  it("caps companions at topN", () => {
    const rows = activity(
      1,
      TODAY,
      "Bench Press",
      "Row",
      "Squat",
      "Deadlift",
      "Curl",
      "Press",
      "Dip"
    );
    const map = buildCompanionMap(rows, TODAY, 2);
    expect(map["bench press"]).toHaveLength(2);
  });

  it("ignores single-exercise activities (no pairs)", () => {
    expect(buildCompanionMap(activity(1, TODAY, "Bench Press"), TODAY)).toEqual(
      {}
    );
  });
});

describe("biasByCompanions", () => {
  const options = ["Bench Press", "Row", "Squat", "Deadlift", "Curl"];
  const companions: CompanionMap = {
    "bench press": ["Row", "Squat"],
    squat: ["Deadlift"],
  };

  it("returns options unchanged when nothing is entered", () => {
    expect(biasByCompanions(options, [], companions)).toEqual(options);
  });

  it("hoists companions of the entered lift to the front", () => {
    const r = biasByCompanions(options, ["Bench Press"], companions);
    // Row (pos 0 -> weight 5) and Squat (pos 1 -> weight 4) lead; the rest keep
    // their base order.
    expect(r.slice(0, 2)).toEqual(["Row", "Squat"]);
    expect(r).toEqual(["Row", "Squat", "Bench Press", "Deadlift", "Curl"]);
  });

  it("combines weight across multiple entered lifts", () => {
    // Both Bench (Squat @ weight 4) and Squat's-companion Deadlift... enter
    // Bench + Curl; only Bench has companions, so Row/Squat lead.
    const r = biasByCompanions(options, ["Bench Press", "Squat"], companions);
    // Entered = {bench, squat}. Bench -> Row(5), Squat(4, but squat is entered so
    // skipped). Squat -> Deadlift(5). So Row(5), Deadlift(5) lead, tie broken by
    // input order (Row before Deadlift).
    expect(r.slice(0, 2)).toEqual(["Row", "Deadlift"]);
  });

  it("does not re-suggest an already-entered companion", () => {
    // Squat is a companion of Bench but is itself entered — it must not hoist.
    const r = biasByCompanions(options, ["Bench Press", "Squat"], companions);
    // Squat keeps its natural slot, not pulled to the front by the Bench pairing.
    expect(r.indexOf("Row")).toBeLessThan(r.indexOf("Squat"));
  });

  it("preserves the input order as a stable tiebreak (non-companions)", () => {
    const r = biasByCompanions(options, ["Bench Press"], companions);
    // Deadlift and Curl aren't companions — they keep their relative order.
    expect(r.indexOf("Deadlift")).toBeLessThan(r.indexOf("Curl"));
  });

  it("returns options unchanged when the entered lift has no companions", () => {
    expect(biasByCompanions(options, ["Deadlift"], companions)).toEqual(
      options
    );
  });
});
