import { describe, it, expect } from "vitest";
import {
  restReasons,
  restRecommendation,
  recommendCoaching,
  DEFAULT_COACHING_THRESHOLDS,
  type CoachingInput,
} from "../coaching";
import { computeReportedBurden } from "../reported-burden";

// #1300: the reported-burden rest tilt inside the coaching engine — its firing, the
// basis-aware copy, and the two precedence rules (illness hold outranks; tilt + poor-sleep
// collapse to ONE rest rec).

const TH = DEFAULT_COACHING_THRESHOLDS;

// A minimal coaching input with training context (so recommendCoaching isn't the empty
// state) and NO physiological rest signal, so a fired rest rec is purely the burden tilt.
function baseInput(over: Partial<CoachingInput> = {}): CoachingInput {
  return {
    today: "2026-06-15",
    routine: [],
    strength: [{ exercise: "Back Squat", lastDate: "2026-06-12" } as never],
    cardio: [],
    trainingDates: ["2026-06-12"],
    sleep: null,
    restingHr: null,
    ...over,
  };
}

const severeCramps = computeReportedBurden({
  symptoms: [{ symptom: "cramps", severity: 3 }],
  energy: null,
});

describe("reported-burden rest tilt", () => {
  it("a severe symptom produces a rest reason naming the report", () => {
    const reasons = restReasons(
      baseInput({ reportedBurden: severeCramps }),
      TH
    );
    const r = reasons.find((x) => x.id === "rest-symptom");
    expect(r).toBeTruthy();
    expect(r!.reasonCore).toBe("You logged severe cramps today");
  });

  it("no burden ⇒ no rest tilt (byte-for-byte the prior behavior)", () => {
    expect(restRecommendation(baseInput(), TH)).toBeNull();
    expect(
      restRecommendation(
        baseInput({
          reportedBurden: computeReportedBurden({ symptoms: [], energy: 4 }),
        }),
        TH
      )
    ).toBeNull();
  });

  it("recommendCoaching leads with the burden rest rec over a train nudge", () => {
    const recs = recommendCoaching(baseInput({ reportedBurden: severeCramps }));
    expect(recs[0].kind).toBe("rest");
    expect(recs[0].detail).toContain("severe cramps");
  });
});

describe("precedence: illness HOLD outranks the tilt (#837)", () => {
  it("an open episode suppresses the symptom tilt (no double-speak under the hold)", () => {
    const reasons = restReasons(
      baseInput({
        reportedBurden: severeCramps,
        illness: { openEpisode: true },
      }),
      TH
    );
    expect(reasons.find((x) => x.id === "rest-symptom")).toBeUndefined();
  });

  it("the tilt still fires in the post-close ease-back window", () => {
    const reasons = restReasons(
      baseInput({
        reportedBurden: severeCramps,
        illness: {
          openEpisode: false,
          lastClosed: { episodeId: 1, endDate: "2026-06-14" },
        },
      }),
      TH
    );
    expect(reasons.find((x) => x.id === "rest-symptom")).toBeTruthy();
  });
});

describe("collapse: tilt + poor-sleep are ONE rest rec (#1292), not two", () => {
  it("both signals collapse to a single rest recommendation with an Also line", () => {
    const rec = restRecommendation(
      baseInput({
        reportedBurden: severeCramps,
        poorSleepDeclared: true,
      }),
      TH
    );
    expect(rec).toBeTruthy();
    expect(rec!.kind).toBe("rest");
    // Poor sleep leads (it's pushed first / higher salience); the symptom rides as "Also:".
    expect(rec!.detail).toContain("rough night");
    expect(rec!.also).toBeTruthy();
    expect(rec!.also!.join(" ")).toContain("severe cramps");
    // recommendCoaching yields exactly ONE rest-kind card, not two.
    const restCards = recommendCoaching(
      baseInput({ reportedBurden: severeCramps, poorSleepDeclared: true })
    ).filter((r) => r.kind === "rest");
    expect(restCards).toHaveLength(1);
  });
});
