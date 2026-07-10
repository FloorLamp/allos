import { describe, it, expect } from "vitest";
import { preventiveAssessmentToUpcomingItem } from "../preventive-upcoming";
import { assessCatalog } from "../preventive-status";
import type { PreventiveAssessment } from "../preventive-status";
import type { Citation } from "../preventive-catalog";

const CITATION: Citation = {
  source: "USPSTF",
  summary: "test",
  reviewed: "2026-07",
};

function mkAssessment(
  over: Partial<PreventiveAssessment> & Pick<PreventiveAssessment, "kind">
): PreventiveAssessment {
  return {
    key: "adult_physical",
    name: "Routine adult check-up",
    status: "due",
    lastDate: null,
    nextDueDate: null,
    nextDueAgeMonths: null,
    detail: "Recommended",
    nextLabel: "Due now",
    override: null,
    citation: CITATION,
    ...over,
  };
}

describe("preventiveAssessmentToUpcomingItem", () => {
  it("maps a due VISIT to a status-driven Today item with the visit domain", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({ kind: "visit", status: "due" })
    );
    expect(item.domain).toBe("visit");
    expect(item.key).toBe("visit:adult_physical");
    expect(item.preventiveRuleKey).toBe("adult_physical");
    expect(item.band).toBe("today");
    expect(item.dueText).toBe("Due");
    expect(item.dueDate).toBeNull();
    expect(item.href).toBe("/appointments");
    expect(item.title).toBe("Routine adult check-up");
    // nextLabel is preferred for the detail line.
    expect(item.detail).toBe("Due now");
  });

  it("maps an overdue SCREENING to the Overdue band with the screening domain", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({
        kind: "screening",
        key: "colorectal_cancer",
        name: "Colorectal cancer screening",
        status: "overdue",
        nextLabel: null,
        detail: "Recommended, none on record",
      })
    );
    expect(item.domain).toBe("screening");
    expect(item.key).toBe("screening:colorectal_cancer");
    expect(item.band).toBe("overdue");
    expect(item.dueText).toBe("Overdue");
    expect(item.href).toBe("/medical");
    // Falls back to detail when nextLabel is null.
    expect(item.detail).toBe("Recommended, none on record");
  });
});

describe("assessCatalog + adapter (pure end-to-end)", () => {
  const today = "2026-07-10";
  // A 40-year-old male: past the adult-physical entry age (22) with no visit on
  // record, and past several screening entry ages (blood pressure 18+, lipids 35+).
  const ageMonths = 40 * 12;

  it("produces visit + screening Upcoming items for a demographics-known profile", () => {
    const summary = assessCatalog({
      ageMonths,
      sex: "male",
      satisfactions: [],
      today,
    });
    const items = summary.actionable.map(preventiveAssessmentToUpcomingItem);
    const domains = new Set(items.map((i) => i.domain));
    expect(domains.has("visit")).toBe(true);
    expect(domains.has("screening")).toBe(true);
    // The adult physical is due with no history.
    expect(items.some((i) => i.key === "visit:adult_physical")).toBe(true);
    // Every mapped item carries its rule key for the inline actions.
    expect(items.every((i) => typeof i.preventiveRuleKey === "string")).toBe(
      true
    );
  });

  it("emits nothing when the age is unknown (assessor contract)", () => {
    const summary = assessCatalog({
      ageMonths: null,
      sex: "male",
      satisfactions: [],
      today,
    });
    expect(summary.actionable.map(preventiveAssessmentToUpcomingItem)).toEqual(
      []
    );
  });

  it("a satisfaction and a declined override each clear the item", () => {
    const base = assessCatalog({
      ageMonths,
      sex: "male",
      satisfactions: [],
      today,
    });
    expect(base.actionable.some((a) => a.key === "adult_physical")).toBe(true);

    // Recording a recent completion advances the next-due out of the window.
    const satisfied = assessCatalog({
      ageMonths,
      sex: "male",
      satisfactions: [{ ruleKey: "adult_physical", date: "2026-06-01" }],
      today,
    });
    expect(satisfied.actionable.some((a) => a.key === "adult_physical")).toBe(
      false
    );

    // A declined override also drops it from the actionable set.
    const declined = assessCatalog({
      ageMonths,
      sex: "male",
      satisfactions: [],
      overrides: [{ ruleKey: "adult_physical", kind: "declined" }],
      today,
    });
    expect(declined.actionable.some((a) => a.key === "adult_physical")).toBe(
      false
    );
  });
});
