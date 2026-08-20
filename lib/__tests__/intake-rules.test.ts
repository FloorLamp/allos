import { describe, expect, it } from "vitest";
import {
  fieldsFromRules,
  keepApartNote,
  nextRuleId,
  parseKeepApartNote,
  rulesFromFields,
  suggestedRulesForFoodTiming,
  type IntakeRule,
} from "@/lib/intake-rules";
import type { IntakePair } from "@/lib/types";

// The five rule sentences (#3216 decision 4) and their round trip to the columns that
// already exist. The invariant under test is not "the builder renders": it is that
// deleting the rules UI would leave the data model unchanged, which is only true if
// every sentence resolves to a field that shipped before this issue.

function pair(over: Partial<IntakePair>): IntakePair {
  return {
    id: 1,
    a_id: 1,
    b_id: 2,
    a_name: "A",
    b_name: "B",
    relation: "separate",
    note: null,
    ...over,
  } as IntakePair;
}

describe("intake rule sentences (#3216)", () => {
  it("'take only when' writes the situational condition AND its situation", () => {
    const f = fieldsFromRules([
      { id: nextRuleId(), type: "only-when", situation: "Illness" },
    ]);
    // Both halves, because either alone is a broken row: a situation with a daily
    // condition never gates, and a situational condition with no situation gates on
    // nothing.
    expect(f.condition).toBe("situational");
    expect(f.situation).toBe("Illness");
  });

  it("an only-when rule with a blank situation writes neither half", () => {
    const f = fieldsFromRules([
      { id: nextRuleId(), type: "only-when", situation: "   " },
    ]);
    expect(f.condition).toBeNull();
    expect(f.situation).toBe("");
  });

  it("'pause while' writes pause_situation and leaves the condition alone", () => {
    const f = fieldsFromRules([
      { id: nextRuleId(), type: "pause-while", situation: "Pre-surgery" },
    ]);
    expect(f.pauseSituation).toBe("Pre-surgery");
    // A daily medication paused during Pre-surgery is still a daily medication.
    expect(f.condition).toBeNull();
  });

  it("a food rule writes the dose rows' food_timing", () => {
    expect(
      fieldsFromRules([
        { id: nextRuleId(), type: "food", timing: "empty_stomach" },
      ]).foodTiming
    ).toBe("empty_stomach");
    // No food rule means the rows keep whatever they carry — not that they are set
    // to "any" behind the person's back.
    expect(fieldsFromRules([]).foodTiming).toBeNull();
  });

  it("keep-apart and take-together write the two pair RELATIONS, not a new store", () => {
    const f = fieldsFromRules([
      { id: nextRuleId(), type: "keep-apart", otherId: 9, hours: 2, note: "" },
      { id: nextRuleId(), type: "take-together", otherId: 4, note: "" },
    ]);
    expect(f.pairs.map((p) => p.relation)).toEqual(["separate", "with"]);
    expect(f.pairs.map((p) => p.otherId)).toEqual([9, 4]);
  });

  it("a pair rule with no other item chosen writes nothing", () => {
    expect(
      fieldsFromRules([
        {
          id: nextRuleId(),
          type: "keep-apart",
          otherId: 0,
          hours: 2,
          note: "",
        },
      ]).pairs
    ).toEqual([]);
  });

  it("the keep-apart interval round-trips through the pair's own note", () => {
    // There is no hours column and #3216 forbids adding one, so the interval rides in
    // the note in a canonical leading form — and comes back out intact.
    const note = keepApartNote(2, "take the iron at lunch");
    expect(parseKeepApartNote(note)).toEqual({
      hours: 2,
      note: "take the iron at lunch",
    });
    expect(keepApartNote(null, "just keep them apart")).toBe(
      "just keep them apart"
    );
  });

  it("a note written by hand before this feature keeps its whole text", () => {
    // The parser must never swallow part of an ordinary note to invent an interval.
    expect(parseKeepApartNote("2 hours is plenty")).toEqual({
      hours: null,
      note: "2 hours is plenty",
    });
    expect(parseKeepApartNote(null)).toEqual({ hours: null, note: "" });
  });

  it("edit mode reads the stored row back as the same sentences", () => {
    const rules = rulesFromFields({
      condition: "situational",
      situation: "Illness",
      pauseSituation: "Pre-surgery",
      foodTiming: "with_food",
      pairs: [
        pair({ a_id: 1, b_id: 9, relation: "separate", note: "2 h apart" }),
        pair({ a_id: 1, b_id: 4, relation: "with" }),
      ],
      selfId: 1,
    });
    expect(rules.map((r) => r.type)).toEqual([
      "only-when",
      "pause-while",
      "food",
      "keep-apart",
      "take-together",
    ]);
    const keepApart = rules.find((r) => r.type === "keep-apart");
    expect(keepApart && "hours" in keepApart && keepApart.hours).toBe(2);
    // And back out again unchanged — the round trip, not just each direction.
    const fields = fieldsFromRules(rules);
    expect(fields.condition).toBe("situational");
    expect(fields.situation).toBe("Illness");
    expect(fields.pauseSituation).toBe("Pre-surgery");
    expect(fields.foodTiming).toBe("with_food");
    expect(fields.pairs).toEqual([
      { otherId: 9, relation: "separate", note: "2 h apart" },
      { otherId: 4, relation: "with", note: "" },
    ]);
  });

  it("'any' food timing is an absence, not a rule stating indifference", () => {
    expect(rulesFromFields({ foodTiming: "any" })).toEqual([]);
  });

  it("a seeded rule arrives marked suggested and is an ordinary deletable rule", () => {
    const seeded = suggestedRulesForFoodTiming("with_food");
    expect(seeded).toHaveLength(1);
    expect(seeded[0].suggested).toBe(true);
    // It writes exactly what a hand-made rule writes — the offer is in the marking,
    // not in a second code path.
    expect(fieldsFromRules(seeded).foodTiming).toBe("with_food");
    // Deleting it before Save writes nothing.
    expect(fieldsFromRules([] as IntakeRule[]).foodTiming).toBeNull();
    expect(suggestedRulesForFoodTiming("any")).toEqual([]);
    expect(suggestedRulesForFoodTiming(null)).toEqual([]);
  });
});
