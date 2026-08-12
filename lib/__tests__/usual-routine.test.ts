// PURE TIER — the composed morning offer's arithmetic and its language (#2458).
//
// The DB-shaped half (which doses are members, and what a stale tap writes) is
// lib/__db_tests__/usual-routine.test.ts. What lives here is the composition rule —
// the food half is the GATE and the dose half is a RIDER — and the two strings the
// whole feature's honesty rests on: the label may not promise a write the core would
// not perform, and the answer may not claim more than was written.

import { describe, it, expect } from "vitest";
import {
  namesPhrase,
  usualRoutineAnswerText,
  usualRoutineOffer,
  usualRoutinePhrase,
} from "@/lib/usual-routine";

const dose = (doseId: number, name: string) => ({
  doseId,
  itemId: doseId * 10,
  name,
  detail: null,
});

describe("usualRoutineOffer (#2458)", () => {
  it("composes both halves when the food half stands", () => {
    expect(
      usualRoutineOffer(
        "Morning",
        ["fermented", "berries"],
        [dose(1, "Creatine")]
      )
    ).toEqual({
      window: "Morning",
      groups: ["fermented", "berries"],
      doses: [dose(1, "Creatine")],
    });
  });

  it("degrades to the plain food offer with no pending doses", () => {
    const offer = usualRoutineOffer("Morning", ["fermented", "berries"], []);
    expect(offer?.groups).toEqual(["fermented", "berries"]);
    expect(offer?.doses).toEqual([]);
  });

  it("is NO CONTROL when the food half does not stand, however many doses are pending", () => {
    // The food half arrives from `usualFoodOffer`, which already returns [] below
    // FOOD_USUAL_MIN_GROUPS — so an empty list here means the offer does not stand,
    // and a dose-only bundle is deliberately not a thing this feature builds.
    expect(
      usualRoutineOffer(
        "Morning",
        [],
        [dose(1, "Creatine"), dose(2, "Collagen")]
      )
    ).toBeNull();
    expect(usualRoutineOffer("Morning", [], [])).toBeNull();
  });

  it("copies both halves, so a caller cannot mutate the offer it was handed", () => {
    const groups = ["fermented", "berries"];
    const offer = usualRoutineOffer("Morning", groups, []);
    groups.push("eggs");
    expect(offer?.groups).toEqual(["fermented", "berries"]);
  });
});

describe("namesPhrase", () => {
  it("reads as English at every length", () => {
    expect(namesPhrase([])).toBe("");
    expect(namesPhrase(["Berries"])).toBe("Berries");
    expect(namesPhrase(["Berries", "Fermented foods"])).toBe(
      "Berries and Fermented foods"
    );
    expect(namesPhrase(["Berries", "Eggs", "Fermented foods"])).toBe(
      "Berries, Eggs and Fermented foods"
    );
  });
});

describe("usualRoutinePhrase — the label names EVERY write", () => {
  it("keeps the seam between servings and dose confirms visible", () => {
    expect(
      usualRoutinePhrase(
        ["Fermented foods", "Berries"],
        ["Creatine", "Collagen", "B-complex"]
      )
    ).toBe("Fermented foods and Berries + Creatine, Collagen and B-complex");
  });

  it("is the food phrase alone when nothing rides it", () => {
    expect(usualRoutinePhrase(["Fermented foods", "Berries"], [])).toBe(
      "Fermented foods and Berries"
    );
  });
});

describe("usualRoutineAnswerText — never claims more than was written", () => {
  it("names both halves on the happy path", () => {
    expect(
      usualRoutineAnswerText(
        ["Fermented foods", "Berries"],
        ["Creatine", "Collagen", "B-complex"],
        []
      )
    ).toBe("Logged Fermented foods and Berries · 3 doses taken");
  });

  it("names the doses that did NOT land rather than folding them into the count", () => {
    expect(
      usualRoutineAnswerText(
        ["Fermented foods", "Berries"],
        ["Collagen"],
        ["Creatine"]
      )
    ).toBe(
      "Logged Fermented foods and Berries · 1 dose taken · Creatine not logged"
    );
  });

  it("reports a food-only or dose-only truth without inventing the other half", () => {
    expect(usualRoutineAnswerText(["Berries"], [], [])).toBe("Logged Berries");
    expect(usualRoutineAnswerText([], ["Creatine"], [])).toBe("1 dose taken");
  });

  it("says nothing was left rather than confirming an empty write", () => {
    expect(usualRoutineAnswerText([], [], [])).toBe("Nothing left to log");
  });
});
