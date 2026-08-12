import { describe, expect, it } from "vitest";
import {
  CADENCE_SCOPES,
  CADENCE_VERDICT_LABEL,
  CAP_VERDICTS,
  FLOOR_VERDICTS,
  cadenceCapWeeksSentence,
  cadenceDirection,
  cadenceScopeNoun,
  cadenceToGo,
  cadenceWeekVerdictLine,
  cadenceVerdict,
  cadenceWeekMet,
  isCadenceScopeKind,
  sessionAdvancesScope,
  verdictDirection,
  SESSION_ADVANCEABLE_SCOPE_KINDS,
  SESSION_ADVANCE_RULES,
  type CadenceVerdict,
  type SessionCadenceFacts,
} from "../cadence";
import {
  FREQUENCY_SCOPE_KINDS,
  type FrequencyScopeKind,
} from "../frequency-targets";
import { frequencyRangeState } from "../practice";
import { substanceCapStatus } from "../substance-use";
import { practiceWeekVerdict } from "../trends-practices";

// The declared axes under the one cadence ledger (#2034): the scope registry, the
// direction parameter that replaced a fourth module, and the anti-nudge guarantee
// that direction had to keep alive when it stopped being a module boundary.

describe("the scope registry", () => {
  it("is TOTAL over FrequencyScopeKind — no kind can be forgotten", () => {
    for (const kind of FREQUENCY_SCOPE_KINDS) {
      const spec = CADENCE_SCOPES[kind];
      expect(spec, kind).toBeDefined();
      expect(spec.note.length, kind).toBeGreaterThan(0);
    }
    expect(Object.keys(CADENCE_SCOPES).sort()).toEqual(
      [...FREQUENCY_SCOPE_KINDS].sort()
    );
  });

  it("declares each scope's source and grain rather than branching on it", () => {
    expect(CADENCE_SCOPES.region).toMatchObject({
      source: "exercise-sets",
      grain: "distinct-days",
      direction: "floor",
    });
    expect(CADENCE_SCOPES.group.source).toBe("exercise-sets");
    expect(CADENCE_SCOPES.type.source).toBe("activity-type");
    expect(CADENCE_SCOPES.mobility_region.source).toBe("mobility-moves");
    expect(CADENCE_SCOPES.practice.source).toBe("practice-logs");
    // The two SUM scopes are the ones whose week is an amount, not a day count.
    expect(CADENCE_SCOPES.food_group.grain).toBe("sum");
    expect(CADENCE_SCOPES.substance.grain).toBe("sum");
  });

  it("names substance as the ONE inverted scope", () => {
    const caps = FREQUENCY_SCOPE_KINDS.filter(
      (k) => CADENCE_SCOPES[k].direction === "cap"
    );
    expect(caps).toEqual(["substance"]);
    expect(cadenceDirection("substance")).toBe("cap");
    expect(cadenceDirection("practice")).toBe("floor");
    // An unregistered kind is not a cadence scope at all — it does not silently
    // default into either direction's readers.
    expect(cadenceDirection("not_a_scope")).toBeNull();
    expect(isCadenceScopeKind("not_a_scope")).toBe(false);
    expect(isCadenceScopeKind("food_group")).toBe(true);
  });
});

describe("the direction axis", () => {
  // ONE fixture series read both ways. The counts are identical; the verdicts are
  // opposites, which is the whole content of the axis.
  const series = [0, 2, 3, 5];
  const target = 3;

  it("reads the same series as a floor and as a cap, with opposite verdicts", () => {
    const asFloor = series.map((count) =>
      cadenceVerdict({ direction: "floor", count, target })
    );
    const asCap = series.map((count) =>
      cadenceVerdict({ direction: "cap", count, target })
    );
    expect(asFloor).toEqual(["under", "under", "met", "met"]);
    expect(asCap).toEqual(["under-cap", "under-cap", "at-cap", "over-cap"]);
    // A week that is a FAILURE under a floor is a SUCCESS under a cap, and vice
    // versa. That inversion is why #998 kept the readers apart; it is now a value.
    expect(asFloor.map(cadenceWeekMet)).toEqual([false, false, true, true]);
    expect(asCap.map(cadenceWeekMet)).toEqual([true, true, true, false]);
  });

  it("delegates to the computations the surfaces already render", () => {
    for (const count of series) {
      const range = frequencyRangeState(count, target, 5, 7);
      const expected = range.atCeiling
        ? "at-ceiling"
        : range.met
          ? "met"
          : "under";
      expect(
        cadenceVerdict({
          direction: "floor",
          count,
          target,
          ceiling: 5,
          elapsedDays: 7,
        })
      ).toBe(expected);

      const cap = substanceCapStatus(count, target);
      expect(cadenceVerdict({ direction: "cap", count, target })).toBe(
        cap.over ? "over-cap" : cap.atCap ? "at-cap" : "under-cap"
      );
    }
  });

  it("carries the range ceiling and the elapsed-week pacing on the floor side", () => {
    expect(
      cadenceVerdict({
        direction: "floor",
        count: 5,
        target: 3,
        ceiling: 5,
        elapsedDays: 7,
      })
    ).toBe("at-ceiling");
    // A cap has no ceiling and no pace — a partly-elapsed week cannot make an
    // under-cap week read as anything else.
    expect(
      cadenceVerdict({ direction: "cap", count: 1, target: 7, elapsedDays: 1 })
    ).toBe("under-cap");
  });

  it("treats a zero cap with nothing logged as the quiet substance-free state", () => {
    expect(cadenceVerdict({ direction: "cap", count: 0, target: 0 })).toBe(
      "under-cap"
    );
    expect(cadenceVerdict({ direction: "cap", count: 1, target: 0 })).toBe(
      "over-cap"
    );
  });

  it("IS the practice lens's verdict, not a parallel vocabulary", () => {
    for (const count of [0, 2, 3, 5, 9]) {
      expect(practiceWeekVerdict(count, 3, 5)).toBe(
        cadenceVerdict({
          direction: "floor",
          count,
          target: 3,
          ceiling: 5,
          elapsedDays: 7,
        })
      );
    }
  });
});

// The safety property #998/#1259 kept by keeping the modules apart. It is now
// structural: a cap direction has no state and no number that could nudge toward
// MORE consumption, and this pin fails if one is ever added.
describe("the anti-nudge pin", () => {
  const all: CadenceVerdict[] = [...FLOOR_VERDICTS, ...CAP_VERDICTS];

  it("keeps the two verdict sets disjoint and correctly attributed", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const v of FLOOR_VERDICTS) expect(verdictDirection(v)).toBe("floor");
    for (const v of CAP_VERDICTS) expect(verdictDirection(v)).toBe("cap");
  });

  it("gives a cap NO to-go / pace state at all", () => {
    // The floor vocabulary's incomplete states have no cap counterpart: there is
    // nothing to be "on pace" toward and nothing "to go" under a limit.
    expect(CAP_VERDICTS).not.toContain("under" as never);
    for (const v of CAP_VERDICTS) {
      expect(FLOOR_VERDICTS).not.toContain(v as never);
    }
  });

  it("never returns a remaining count for the cap direction", () => {
    for (const count of [0, 1, 5, 20]) {
      expect(cadenceToGo("cap", count, 7)).toBeNull();
      expect(cadenceToGo("floor", count, 7)).toBe(Math.max(0, 7 - count));
    }
  });

  it("renders no cap label that reads as room left to fill", () => {
    const nudging = /to go|left|remaining|behind|on pace|more|keep going/i;
    for (const v of CAP_VERDICTS) {
      expect(CADENCE_VERDICT_LABEL[v], v).not.toMatch(nudging);
    }
    for (const v of all) {
      expect(CADENCE_VERDICT_LABEL[v], v).toBeTruthy();
    }
  });

  it("makes UNDER-cap a success state, the way #1670 ruled", () => {
    expect(cadenceWeekMet("under-cap")).toBe(true);
    expect(cadenceWeekMet("at-cap")).toBe(true);
    expect(cadenceWeekMet("over-cap")).toBe(false);
  });
});

// ── What ONE session advances (#2503) ───────────────────────────────────────────
//
// The ledger's membership rule asked of a single activity. It exists because the
// post-workout recap read the profile-wide weekly rollup as if the finishing session
// had produced it, and a walk was congratulated for a chest target a barbell session
// had advanced days earlier.

describe("sessionAdvancesScope", () => {
  const legDay: SessionCadenceFacts = {
    types: ["strength"],
    regions: ["Legs"],
  };
  const walk: SessionCadenceFacts = { types: ["cardio"], regions: [] };

  it("is TOTAL over FrequencyScopeKind — a new scope must answer", () => {
    expect(Object.keys(SESSION_ADVANCE_RULES).sort()).toEqual(
      [...FREQUENCY_SCOPE_KINDS].sort()
    );
  });

  it("matches a region the session's sets actually mapped to", () => {
    expect(
      sessionAdvancesScope({ kind: "region", value: "Legs" }, legDay)
    ).toBe(true);
    expect(
      sessionAdvancesScope({ kind: "region", value: "Chest" }, legDay)
    ).toBe(false);
    // A session with no sets at all maps to no region — the walk's whole problem.
    expect(sessionAdvancesScope({ kind: "region", value: "Chest" }, walk)).toBe(
      false
    );
  });

  it("takes a group as the union of its regions, the way the ledger counts it", () => {
    expect(
      sessionAdvancesScope({ kind: "group", value: "Lower" }, legDay)
    ).toBe(true);
    expect(
      sessionAdvancesScope({ kind: "group", value: "Upper" }, legDay)
    ).toBe(false);
    expect(sessionAdvancesScope({ kind: "group", value: "Full" }, legDay)).toBe(
      true
    );
  });

  it("reads the activity's own type and its components' types", () => {
    expect(sessionAdvancesScope({ kind: "type", value: "cardio" }, walk)).toBe(
      true
    );
    expect(
      sessionAdvancesScope({ kind: "type", value: "strength" }, walk)
    ).toBe(false);
    expect(
      sessionAdvancesScope(
        { kind: "type", value: "cardio" },
        { types: ["strength", "cardio"], regions: ["Chest"] }
      )
    ).toBe(true);
  });

  it("declines the scopes an activity row cannot answer for", () => {
    // Null is "unanswerable here", not "no": the mobility ledger reads a recovery
    // session's MOVES (#840), and food/practice count their own ledgers. A cap is never
    // advanced at all (#998) — asking would be asking for a to-go number on alcohol.
    for (const kind of [
      "mobility_region",
      "food_group",
      "practice",
      "substance",
    ])
      expect(
        SESSION_ADVANCE_RULES[kind as FrequencyScopeKind],
        kind
      ).toBeNull();
    expect(
      sessionAdvancesScope({ kind: "substance", value: "alcohol" }, walk)
    ).toBe(false);
    expect(
      sessionAdvancesScope({ kind: "mobility_region", value: "Legs" }, legDay)
    ).toBe(false);
    // An unregistered kind is not a yes either.
    expect(sessionAdvancesScope({ kind: "invented", value: "x" }, legDay)).toBe(
      false
    );
  });

  it("derives the workout-affectable kinds from the rules themselves", () => {
    // The recap's #1122 narrowing reads this rather than keeping its own list, so the
    // two cannot drift apart.
    expect([...SESSION_ADVANCEABLE_SCOPE_KINDS].sort()).toEqual([
      "group",
      "region",
      "type",
    ]);
  });
});

// ── The CLOSED week's verdict line (#2395) ──────────────────────────────────────
//
// The daily digest reports a weekly target's PACE and the message that closes the week
// reported nothing about the targets at all. This is the twin of that rollup, over a
// verdict rather than a pace — so the pins here are the same anti-nudge pins as above,
// asked of a SENTENCE instead of a label. A cap tenant must be able to reach this line
// (a profile that set an alcohol cap wants to know it held) without the line ever
// speaking a floor's vocabulary about it.

describe("cadenceWeekVerdictLine (#2395)", () => {
  const floor = (label: string, verdict: CadenceVerdict, over = false) => ({
    label,
    direction: "floor" as const,
    verdict,
    ...(over ? { overCeiling: true } : {}),
  });
  const cap = (label: string, verdict: CadenceVerdict) => ({
    label,
    direction: "cap" as const,
    verdict,
  });

  it("says nothing for a profile with no targets", () => {
    expect(cadenceWeekVerdictLine([])).toBeNull();
  });

  it("rolls floors up as met, naming what fell short", () => {
    const line = cadenceWeekVerdictLine([
      floor("Back", "under"),
      floor("Cardio", "met"),
      floor("Legs", "at-ceiling"),
      floor("Chest", "met"),
      floor("Core", "met"),
    ]);
    expect(line).toEqual({
      value: "4 of 5 targets met",
      notes: ["short on Back"],
    });
  });

  it("counts at-ceiling as met — the range model's most complete state", () => {
    expect(
      cadenceWeekVerdictLine([floor("Mobility", "at-ceiling")])?.value
    ).toBe("1 of 1 target met");
  });

  it("counts the overflow of a long shortfall list rather than listing it", () => {
    const line = cadenceWeekVerdictLine(
      ["Back", "Chest", "Legs", "Core", "Cardio"].map((l) => floor(l, "under"))
    );
    expect(line?.notes).toEqual(["short on Back, Chest, Legs, +2 more"]);
  });

  it("reports a cap as held or over, and NEVER with a figure to go", () => {
    const line = cadenceWeekVerdictLine([
      floor("Cardio", "met"),
      cap("Alcohol", "over-cap"),
      cap("Nicotine", "under-cap"),
    ]);
    expect(line?.value).toBe("1 of 1 target met");
    expect(line?.notes).toEqual([
      "over the Alcohol cap",
      "within the Nicotine cap",
    ]);
    // The pin, restated at sentence level: no clause anywhere on this line may read as
    // room left to fill under a limit (#998).
    const nudging = /to go|left|remaining|behind|on pace|more of|keep going/i;
    for (const note of line!.notes) expect(note, note).not.toMatch(nudging);
  });

  it("gives a cap-only profile a cap-only head", () => {
    // Rolling caps into "targets met" would state a floor's success condition over a
    // scope that has no floor.
    expect(
      cadenceWeekVerdictLine([
        cap("Alcohol", "under-cap"),
        cap("Nicotine", "at-cap"),
      ])
    ).toEqual({ value: "2 of 2 weekly caps held", notes: [] });
    expect(cadenceWeekVerdictLine([cap("Alcohol", "over-cap")])).toEqual({
      value: "0 of 1 weekly cap held",
      notes: ["over the Alcohol cap"],
    });
  });

  it("reports a floor-plus-ceiling target's FLOOR verdict, mentioning the ceiling only when passed", () => {
    // #2395's ruling for a target carrying both. Reaching the weekly maximum is the calm
    // "that's plenty" state (`at-ceiling` is a MET verdict); only passing it is a fact.
    expect(
      cadenceWeekVerdictLine([floor("Sauna", "at-ceiling")])?.notes
    ).toEqual([]);
    expect(cadenceWeekVerdictLine([floor("Sauna", "met", true)])).toEqual({
      value: "1 of 1 target met",
      notes: ["past the weekly maximum on Sauna"],
    });
  });

  it("names the substance plainly, without the chip's own direction suffix", () => {
    // `frequencyScopeLabel` annotates a substance chip with "(weekly cap)" because a chip
    // has no sentence to carry the direction; a sentence does, and pasting the annotation
    // in produces "over the Alcohol (weekly cap) cap".
    expect(cadenceScopeNoun("substance", "alcohol")).toBe("Alcohol");
    expect(cadenceScopeNoun("group", "Upper")).toBe("Upper body");
  });
});

// ── A cap over SEVERAL closed weeks (#2397) ─────────────────────────────────────

describe("cadenceCapWeeksSentence (#2397)", () => {
  it("states the exceedance as a share of the weeks, never as a run", () => {
    expect(
      cadenceCapWeeksSentence({ label: "Alcohol", overWeeks: 3, weeks: 4 })
    ).toBe("over the Alcohol cap in 3 of 4 weeks");
  });

  it("says a clean period held rather than going silent", () => {
    // Silence would be indistinguishable from having declared no cap at all, and
    // under-cap is the SUCCESS state (#1670) — it is worth saying.
    expect(
      cadenceCapWeeksSentence({ label: "Nicotine", overWeeks: 0, weeks: 4 })
    ).toBe("Nicotine cap held all 4 weeks");
  });

  it("carries no pace, no to-go and no comparative in either branch", () => {
    const nudging =
      /to go|left|remaining|behind|on pace|more of|keep going|streak|in a row/i;
    for (const overWeeks of [0, 1, 4]) {
      const s = cadenceCapWeeksSentence({
        label: "Alcohol",
        overWeeks,
        weeks: 4,
      });
      expect(s, s).not.toMatch(nudging);
    }
  });
});
