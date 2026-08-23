import { describe, it, expect } from "vitest";
import {
  firstInjuryProblem,
  injuryFactSummary,
  INJURY_FACT_NOUNS,
  lateralityFactLabel,
  loadFactorFactLabel,
  moreInjuryFactsLabel,
  reviewDateFactLabel,
  type InjuryFactInput,
  type InjuryFactKey,
} from "@/lib/injury-facts";
import {
  INJURY_LATERALITIES,
  INJURY_MOVEMENT_PATTERNS,
  MOVEMENT_PATTERN_LABEL,
} from "@/lib/injury-model";
import { REGION_SCOPES } from "@/lib/lifts";

// The injury bar's fact row (#3221), the pure half. What a test asserts here is which
// facts the row STATES, which it prompts for and which fall behind the trailing
// affordance — never the wording, which is copy.

function input(over: Partial<InjuryFactInput> = {}): InjuryFactInput {
  return {
    label: "",
    regions: [],
    laterality: "",
    movements: [],
    exercises: [],
    loadFactor: "",
    reviewDate: "",
    status: "active",
    ...over,
  };
}

const keys = (s: { chips: { key: InjuryFactKey }[] }) =>
  s.chips.map((c) => c.key);

const chip = (s: ReturnType<typeof injuryFactSummary>, key: InjuryFactKey) =>
  s.chips.find((c) => c.key === key);

describe("the row states the two facts the write refuses without (#3221)", () => {
  it("prompts for the label and the region as MISSING essentials, not as absences", () => {
    // `logInjuryCore` refuses without a label and at least one region, and the action
    // says so ("Add a label and at least one affected region."). A fact the form already
    // knows it wants is a dashed prompt on screen, never something quietly behind the
    // trailing affordance.
    const s = injuryFactSummary(input());
    expect(chip(s, "label")?.state).toBe("missing");
    expect(chip(s, "regions")?.state).toBe("missing");
    expect(s.more).not.toContain("label");
    expect(s.more).not.toContain("regions");
  });

  it("states them once they are answered", () => {
    const s = injuryFactSummary(
      input({ label: "  Right shoulder  ", regions: ["Chest", "Shoulders"] })
    );
    expect(chip(s, "label")).toEqual({
      key: "label",
      label: "Right shoulder",
      state: "stated",
    });
    expect(chip(s, "regions")?.state).toBe("stated");
    // The region vocabulary is `lib/lifts`' REGION_SCOPES, reached through
    // `lib/injury-model` — the chip joins those names rather than inventing labels for
    // them (#2948's one-vocabulary invariant, #3221's third criterion).
    expect(chip(s, "regions")?.label).toBe("Chest, Shoulders");
  });
});

describe("the #2024 precision is optional and silent when empty", () => {
  it("puts the side, the movements and the lifts behind the trailing affordance", () => {
    // #2024's own posture: "leaving every field alone records exactly the region-scoped
    // constraint this form always recorded". An absent optional is not a gap in the
    // record, so the row must not accuse the person of one.
    const s = injuryFactSummary(input({ label: "knee", regions: ["Legs"] }));
    expect(keys(s)).toEqual(["label", "regions", "status"]);
    expect(s.more).toEqual([
      "laterality",
      "movements",
      "exercises",
      "loadFactor",
      "reviewDate",
    ]);
  });

  it("states each one, in reading order, once it says something", () => {
    const s = injuryFactSummary(
      input({
        label: "knee",
        regions: ["Legs"],
        laterality: "right",
        movements: ["push"],
        exercises: ["curl"],
        loadFactor: "0.7",
        reviewDate: "2026-09-12",
      })
    );
    expect(keys(s)).toEqual([
      "label",
      "regions",
      "laterality",
      "movements",
      "exercises",
      "status",
      "loadFactor",
      "reviewDate",
    ]);
    expect(s.more).toEqual([]);
  });

  it("renders a stored exercise identity in the catalog's own casing", () => {
    // The constraint is stored as a canonical key; the chip must read like what the
    // person picked rather than the lowercase key it is kept as (#2199).
    const s = injuryFactSummary(
      input({ label: "elbow", regions: ["Arms"], exercises: ["curl"] })
    );
    expect(chip(s, "exercises")?.label).toBe("Curl");
  });
});

describe("the status chip states what SAVE will write, and only that", () => {
  it("is stated on the log form, where a new injury is born with one", () => {
    expect(chip(injuryFactSummary(input()), "status")?.label).toBe("Active");
    expect(
      chip(injuryFactSummary(input({ status: "recovering" })), "status")?.label
    ).toBe("Recovering");
  });

  it("is absent from the edit form, and does not fall behind the affordance either", () => {
    // `updateInjury` is a PARTIAL that names the declaration only (#2359) — the
    // lifecycle is the chip's own Recovering/Resolve buttons. A status chip here would
    // state a fact this form does not write, which is the one thing the row exists not
    // to do. It is NOT an absent optional: the trailing affordance would offer to edit
    // it.
    const s = injuryFactSummary(
      input({ label: "knee", regions: ["Legs"], status: null })
    );
    expect(keys(s)).not.toContain("status");
    expect(s.more).not.toContain("status");
  });
});

describe("what each chip reads", () => {
  it("says both sides rather than 'bilateral side'", () => {
    expect(lateralityFactLabel("right")).toBe("right side");
    expect(lateralityFactLabel("bilateral")).toBe("both sides");
    expect(lateralityFactLabel("")).toBeNull();
    expect(lateralityFactLabel(null)).toBeNull();
  });

  it("stays silent about the load factor the person never set", () => {
    // "" is the app's disclosed 60% fallback. A chip reading "easing to 60%" would
    // assert a preference nobody expressed (#846), so the empty case has no chip at all.
    expect(loadFactorFactLabel("")).toBeNull();
    expect(loadFactorFactLabel("   ")).toBeNull();
    expect(loadFactorFactLabel("not-a-number")).toBeNull();
    expect(loadFactorFactLabel("0.7")).toBe("easing to 70%");
    const s = injuryFactSummary(input({ label: "x", regions: ["Legs"] }));
    expect(s.more).toContain("loadFactor");
  });

  it("dates the review reminder and drops a blank one", () => {
    expect(reviewDateFactLabel("")).toBeNull();
    expect(reviewDateFactLabel("2026-09-12")).toContain("revisit");
    expect(reviewDateFactLabel("2026-09-12")).toContain("12");
  });

  it("names the absent optionals in the trailing affordance rather than saying 'more'", () => {
    const s = injuryFactSummary(input({ label: "x", regions: ["Legs"] }));
    const label = moreInjuryFactsLabel(s.more);
    for (const key of s.more) expect(label).toContain(INJURY_FACT_NOUNS[key]);
    expect(moreInjuryFactsLabel([])).toBe("");
  });
});

describe("the vocabulary is lib/injury-model's, with no parallel list (#2948)", () => {
  it("renders every movement pattern through MOVEMENT_PATTERN_LABEL", () => {
    // A census rather than a spot check: the guard exists to catch a SECOND list being
    // introduced here, and a second list is most likely to differ on the pattern nobody
    // spot-checked.
    for (const m of INJURY_MOVEMENT_PATTERNS) {
      const s = injuryFactSummary(
        input({ label: "x", regions: ["Legs"], movements: [m] })
      );
      expect(chip(s, "movements")?.label).toBe(MOVEMENT_PATTERN_LABEL[m]);
    }
  });

  it("states every region scope by its own name and every laterality by the model's", () => {
    for (const r of REGION_SCOPES) {
      const s = injuryFactSummary(input({ label: "x", regions: [r] }));
      expect(chip(s, "regions")?.label).toBe(r);
    }
    for (const l of INJURY_LATERALITIES)
      expect(lateralityFactLabel(l)).toContain(
        l === "bilateral" ? "both" : l
      );
  });
});

describe("the submit guard mirrors the action's own refusal (#3221)", () => {
  it("names the label first, then the region, then nothing", () => {
    // `required` cannot do this any more: a required control inside a hidden panel makes
    // the browser refuse the submit with an error it will not show. So the form asks,
    // and the answer has to say WHICH fact's editor to open.
    expect(firstInjuryProblem({ label: "", regions: [] })?.fact).toBe("label");
    expect(firstInjuryProblem({ label: "   ", regions: ["Legs"] })?.fact).toBe(
      "label"
    );
    expect(firstInjuryProblem({ label: "knee", regions: [] })?.fact).toBe(
      "regions"
    );
    expect(firstInjuryProblem({ label: "knee", regions: ["Legs"] })).toBeNull();
  });

  it("only ever names a fact the row actually draws a chip for", () => {
    // A guard that opens a panel the row cannot reach would strand the person in a form
    // that refuses to submit and shows nothing.
    const summary = injuryFactSummary(input());
    for (const f of [
      firstInjuryProblem({ label: "", regions: [] }),
      firstInjuryProblem({ label: "knee", regions: [] }),
    ]) {
      expect(f).not.toBeNull();
      expect(keys(summary)).toContain(f!.fact);
    }
  });
});
