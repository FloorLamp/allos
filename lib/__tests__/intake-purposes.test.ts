import { describe, it, expect } from "vitest";
import {
  GOAL_PURPOSES,
  goalPurposeLabel,
  isGoalPurposeKey,
  normalizePurposeDrafts,
  parseItemPurposes,
  purposeDraftsSummary,
  purposeIdentity,
  purposeLabel,
  purposeToDraft,
  suggestGoalPurposes,
  type IntakeItemPurpose,
  type PurposeDraft,
} from "../intake-purposes";

// PURE TIER — purpose links for intake items (issue #2857).
//
// An intake item had no structured "why": a supplement's reason lived in `notes` as
// prose no engine could read. These are the properties of the model that replaces it —
// the vocabulary's closure, the write boundary's refusals, the round trip the edit form
// depends on, and the one suggest-only feeder.

describe("the goal vocabulary", () => {
  it("is closed — an unknown key is refused, not stored", () => {
    expect(isGoalPurposeKey("eyes")).toBe(true);
    for (const key of ["", "EYES", "vibes", "eye health", "eyes "]) {
      expect(isGoalPurposeKey(key), key).toBe(false);
    }
  });

  it("has unique keys and unique labels", () => {
    const keys = GOAL_PURPOSES.map((g) => g.key);
    const labels = GOAL_PURPOSES.map((g) => g.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("renders an unknown key as itself rather than as nothing", () => {
    // A row written before a key was retired must still show something a person can
    // recognize and remove. An empty label is a chip nobody can find.
    expect(goalPurposeLabel("eyes")).toBe("Eye health");
    expect(goalPurposeLabel("retired-key")).toBe("retired-key");
  });
});

describe("the write boundary", () => {
  it("keeps one row per stated reason, in the order they were stated", () => {
    const rows = normalizePurposeDrafts([
      { kind: "goal", goalKey: "heart" },
      { kind: "goal", goalKey: "joints" },
      { kind: "condition", conditionId: 7 },
      {
        kind: "biomarker",
        biomarkerKey: "Vitamin D, 25-Hydroxy",
        direction: "low",
      },
    ]);
    expect(rows).toEqual([
      {
        kind: "goal",
        goal_key: "heart",
        condition_id: null,
        biomarker_key: null,
        direction: null,
      },
      {
        kind: "goal",
        goal_key: "joints",
        condition_id: null,
        biomarker_key: null,
        direction: null,
      },
      {
        kind: "condition",
        goal_key: null,
        condition_id: 7,
        biomarker_key: null,
        direction: null,
      },
      {
        kind: "biomarker",
        goal_key: null,
        condition_id: null,
        biomarker_key: "Vitamin D, 25-Hydroxy",
        direction: "low",
      },
    ]);
  });

  it("carries a HIGH direction as readily as a LOW one", () => {
    // Direction-agnostic on purpose (#2754): high LDL leading to psyllium is as real a
    // reason to start something as low 25-OH-D leading to D3, and a model that only
    // spoke deficiency-repletion could not say the first one at all.
    const [row] = normalizePurposeDrafts([
      { kind: "biomarker", biomarkerKey: "LDL Cholesterol", direction: "high" },
    ]);
    expect(row.direction).toBe("high");
    // And a direction is OPTIONAL — the analyte's identity is the reason.
    const [bare] = normalizePurposeDrafts([
      { kind: "biomarker", biomarkerKey: "ApoB" },
    ]);
    expect(bare.direction).toBeNull();
  });

  it("drops what it cannot render instead of refusing the whole save", () => {
    // A purpose is an annotation. Refusing somebody's entire item edit over an
    // unrenderable optional link would be the wrong trade — every drop here is a row
    // the form itself could not have produced.
    const rows = normalizePurposeDrafts([
      { kind: "goal", goalKey: "vibes" },
      { kind: "condition", conditionId: 0 },
      { kind: "condition", conditionId: -3 },
      { kind: "condition", conditionId: 1.5 },
      { kind: "biomarker", biomarkerKey: "   " },
      { kind: "goal", goalKey: "sleep" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].goal_key).toBe("sleep");
  });

  it("dedupes by target, ignoring the direction", () => {
    // "low 25-OH-D" and "25-OH-D" are the same statement about the same analyte with
    // more or less context. Storing both renders the same purpose twice.
    const rows = normalizePurposeDrafts([
      { kind: "goal", goalKey: "eyes" },
      { kind: "goal", goalKey: "eyes" },
      { kind: "condition", conditionId: 4 },
      { kind: "condition", conditionId: 4 },
      { kind: "biomarker", biomarkerKey: "Ferritin", direction: "low" },
      { kind: "biomarker", biomarkerKey: "ferritin", direction: "high" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["goal", "condition", "biomarker"]);
    // The FIRST statement wins, so the direction the person stated first is kept.
    expect(rows[2].direction).toBe("low");
  });

  it("gives a goal and a condition with the same number distinct identities", () => {
    expect(
      purposeIdentity({
        kind: "goal",
        goal_key: "4",
        condition_id: null,
        biomarker_key: null,
        direction: null,
      })
    ).not.toBe(
      purposeIdentity({
        kind: "condition",
        goal_key: null,
        condition_id: 4,
        biomarker_key: null,
        direction: null,
      })
    );
  });
});

describe("the round trip the edit form depends on", () => {
  const stored: IntakeItemPurpose[] = [
    {
      id: 1,
      item_id: 9,
      kind: "goal",
      goal_key: "eyes",
      condition_id: null,
      biomarker_key: null,
      direction: null,
      sort: 0,
    },
    {
      id: 2,
      item_id: 9,
      kind: "condition",
      goal_key: null,
      condition_id: 12,
      biomarker_key: null,
      direction: null,
      sort: 1,
    },
    {
      id: 3,
      item_id: 9,
      kind: "biomarker",
      goal_key: null,
      condition_id: null,
      biomarker_key: "Vitamin D, 25-Hydroxy",
      direction: "low",
      sort: 2,
    },
  ];

  it("re-posts exactly what was stored", () => {
    const drafts = stored
      .map(purposeToDraft)
      .filter((d): d is PurposeDraft => d != null);
    expect(normalizePurposeDrafts(drafts)).toEqual(
      stored.map((p) => ({
        kind: p.kind,
        goal_key: p.goal_key,
        condition_id: p.condition_id,
        biomarker_key: p.biomarker_key,
        direction: p.direction,
      }))
    );
  });

  it("drops a stored row whose target is missing rather than posting a half-row", () => {
    expect(purposeToDraft({ ...stored[0], goal_key: null })).toBeNull();
    expect(purposeToDraft({ ...stored[1], condition_id: null })).toBeNull();
    expect(purposeToDraft({ ...stored[2], biomarker_key: null })).toBeNull();
  });

  it("decodes the projected JSON, and treats absent or malformed as none", () => {
    expect(parseItemPurposes(JSON.stringify(stored))).toEqual(stored);
    for (const bad of [null, undefined, "", "not json", "{}", "7"]) {
      expect(parseItemPurposes(bad), String(bad)).toEqual([]);
    }
  });
});

describe("how a purpose reads", () => {
  it("says the direction the way somebody says it out loud", () => {
    expect(
      purposeLabel({
        kind: "biomarker",
        goal_key: null,
        biomarker_key: "LDL Cholesterol",
        direction: "high",
      })
    ).toBe("high LDL Cholesterol");
    expect(
      purposeLabel({
        kind: "biomarker",
        goal_key: null,
        biomarker_key: "ApoB",
        direction: null,
      })
    ).toBe("ApoB");
  });

  it("takes the condition's LIVE name, and says nothing when it is gone", () => {
    // The row stores the id (#203), so a rename follows and a deleted condition leaves
    // no dangling "For: ".
    const row = {
      kind: "condition" as const,
      goal_key: null,
      biomarker_key: null,
      direction: null,
    };
    expect(purposeLabel(row, "Age-related macular degeneration")).toBe(
      "Age-related macular degeneration"
    );
    expect(purposeLabel(row, null)).toBeNull();
    expect(purposeLabel(row, "  ")).toBeNull();
  });
});

describe("the composition feeder", () => {
  it("offers the eyes goal for the carotenoids that mean one thing", () => {
    // The issue's own first row: "Astaxanthin/Lutein/Zeaxanthin — taken for eye health.
    // No field can say so." The composition became readable at all only with #2856.
    for (const token of ["Lutein", "Zeaxanthin", "Astaxanthin"]) {
      expect(
        suggestGoalPurposes({ name: "Eye Health+", ingredientNames: [token] }),
        token
      ).toEqual(["eyes"]);
    }
    // The item's own NAME counts too — a bottle named after what is in it needs no
    // composition rows.
    expect(
      suggestGoalPurposes({
        name: "Astaxanthin/Lutein/Zeaxanthin",
        ingredientNames: [],
      })
    ).toEqual(["eyes"]);
  });

  it("offers nothing it cannot stand behind", () => {
    // A suggestion nobody would accept is worse than none: it teaches people to dismiss
    // the good ones. Only the eye carotenoids have a composition signature this
    // unambiguous, so nothing else is inferred.
    expect(
      suggestGoalPurposes({
        name: "Magnesium Glycinate",
        ingredientNames: ["Magnesium", "Glycine"],
      })
    ).toEqual([]);
    expect(
      suggestGoalPurposes({ name: "Melatonin", ingredientNames: [] })
    ).toEqual([]);
  });

  it("never re-offers something already declared", () => {
    expect(
      suggestGoalPurposes({
        name: "Eye Health+",
        ingredientNames: ["Lutein"],
        declared: [
          {
            kind: "goal",
            goal_key: "eyes",
            condition_id: null,
            biomarker_key: null,
            direction: null,
          },
        ],
      })
    ).toEqual([]);
  });

  it("matches whole tokens, never substrings", () => {
    // The shared tokenContains matcher, not a second vocabulary — so an ingredient that
    // merely CONTAINS the letters does not fire.
    expect(
      suggestGoalPurposes({ name: "Absolutein Blend", ingredientNames: [] })
    ).toEqual([]);
  });
});

describe("purposeDraftsSummary (#4672)", () => {
  const conditions = [
    { id: 51, name: "Ear infection" },
    { id: 52, name: "Migraine" },
  ];

  it("joins each draft's label, resolving a condition id to its live name", () => {
    expect(
      purposeDraftsSummary(
        [
          { kind: "condition", conditionId: 51 },
          { kind: "goal", goalKey: "sleep" },
        ],
        conditions
      )
    ).toContain("Ear infection");
  });

  it("drops a condition whose id this profile no longer has", () => {
    // POSITIVE CONTROL: the same draft with a KNOWN id does produce a label, so the
    // empty answer below is the missing name and not a summary that never builds.
    expect(
      purposeDraftsSummary([{ kind: "condition", conditionId: 51 }], conditions)
    ).not.toBe("");
    expect(
      purposeDraftsSummary(
        [{ kind: "condition", conditionId: 999 }],
        conditions
      )
    ).toBe("");
  });

  it("is empty for no purposes", () => {
    expect(purposeDraftsSummary([], conditions)).toBe("");
  });
});
