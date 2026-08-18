import { describe, it, expect } from "vitest";
import { sessionProgressDelta } from "@/lib/progress-delta";

const session = (
  topWeightKg: number | null,
  topReps: number | null,
  e1rmKg: number | null = null,
  bodyweightBaseKg = 0
) => ({ topWeightKg, topReps, e1rmKg, bodyweightBaseKg });

describe("sessionProgressDelta (#2870 'vs last')", () => {
  it("reports the top-set move in the READER's unit, not the stored one", () => {
    // 100 → 102.5 kg is +2.5 kg, and +5.5 lb. A reader who logs in pounds must
    // not be told "+2.5" about plates they never touched.
    const kg = sessionProgressDelta(session(102.5, 5), session(100, 5), "kg");
    expect(kg).toMatchObject({ direction: "up", label: "+2.5 kg" });
    const lb = sessionProgressDelta(session(102.5, 5), session(100, 5), "lb");
    expect(lb).toMatchObject({ direction: "up", label: "+5.5 lb" });
  });

  it("falls to reps when the load is identical — the usual way a set progresses", () => {
    expect(
      sessionProgressDelta(session(100, 8), session(100, 6), "kg")
    ).toMatchObject({ direction: "up", label: "+2 reps" });
    expect(
      sessionProgressDelta(session(100, 5), session(100, 6), "kg")
    ).toMatchObject({ direction: "down", label: "−1 rep" });
  });

  it("says 'same as last' rather than nothing — holding a load is information", () => {
    expect(
      sessionProgressDelta(session(100, 5), session(100, 5), "kg")
    ).toMatchObject({ direction: "same", label: "same as last" });
  });

  it("does not report a float artifact as a change", () => {
    // 100 kg in pounds is 220.462…; both sides round before comparing, so an
    // identical load can never render as "+0 lb".
    const same = sessionProgressDelta(session(100, 5), session(100, 5), "lb");
    expect(same?.direction).toBe("same");
  });

  it("uses e1RM only when a top load is missing on either side", () => {
    // A bodyweight or reps-only session has no comparable load.
    expect(
      sessionProgressDelta(session(null, 12, 90), session(null, 10, 85), "kg")
    ).toMatchObject({ direction: "up", label: "+5 kg e1RM" });
    // But when both DO carry a load, the load is the answer — not the estimate.
    expect(
      sessionProgressDelta(session(100, 5, 112), session(100, 5, 999), "kg")
    ).toMatchObject({ direction: "same" });
  });

  it("does not report WEIGHT LOSS as a strength regression on a bodyweight lift", () => {
    // Two identical pull-up sessions, three kilos of the athlete apart. The
    // stored "top weight" for a bodyweight lift IS bodyweight + any added load,
    // so comparing totals would say "−3 kg" about a session that was the same
    // work — and would call losing weight a regression.
    const lighter = session(78, 10, null, 78);
    const heavier = session(81, 10, null, 81);
    expect(sessionProgressDelta(lighter, heavier, "kg")).toMatchObject({
      direction: "same",
    });
    // Added load still reads, and reads as ITSELF rather than as bodyweight plus
    // itself: +5 kg on the belt after a 3 kg bodyweight drop is +5, not +2.
    expect(
      sessionProgressDelta(session(83, 8, null, 78), heavier, "kg")
    ).toMatchObject({ direction: "up", label: "+5 kg" });
    // And more reps at the same (zero) added load is still progress.
    expect(
      sessionProgressDelta(session(78, 12, null, 78), heavier, "kg")
    ).toMatchObject({ direction: "up", label: "+2 reps" });
  });

  it("says nothing when there is nothing honest to compare", () => {
    expect(
      sessionProgressDelta(session(null, 10), session(null, 8), "kg")
    ).toBeNull();
    expect(
      sessionProgressDelta(session(100, 5), session(null, 5), "kg")
    ).toBeNull();
  });
});
