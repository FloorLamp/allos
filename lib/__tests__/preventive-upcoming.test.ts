import { describe, it, expect } from "vitest";
import {
  preventiveAssessmentToUpcomingItem,
  preventiveHref,
} from "../preventive-upcoming";
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
    href: null,
    override: null,
    citation: CITATION,
    riskReasons: [],
    riskPriority: 0,
    ...over,
  };
}

const TODAY = "2026-07-10";

describe("preventiveHref", () => {
  it("visits always act through the appointments surface", () => {
    expect(preventiveHref("visit", "adult_physical")).toBe("/records#visits");
    expect(preventiveHref("visit", "dental_cleaning")).toBe("/records#visits");
  });

  it("derives a screening's surface from what satisfies it (issue #283)", () => {
    // Lab-satisfied (the concept map lists canonical biomarkers) → biomarkers.
    expect(preventiveHref("screening", "lipid_screening")).toBe(
      "/results#biomarkers"
    );
    expect(preventiveHref("screening", "diabetes_screening")).toBe(
      "/results#biomarkers"
    );
    // Procedure/coded-satisfied → procedures.
    expect(preventiveHref("screening", "colorectal_cancer")).toBe(
      "/records#procedures"
    );
    expect(preventiveHref("screening", "osteoporosis")).toBe("/records#procedures");
  });

  it("falls back to the passport for a rule the concept map can't satisfy", () => {
    // Manual-only rules (e.g. the risk-gated lung LDCT) have no concept-map
    // entry; their completion is recorded on the passport.
    expect(preventiveHref("screening", "lung_cancer_ldct")).toBe("/profile");
  });
});

describe("preventiveAssessmentToUpcomingItem", () => {
  it("maps a due VISIT to a status-driven Today item with the visit domain", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({ kind: "visit", status: "due" }),
      { today: TODAY }
    );
    expect(item.domain).toBe("visit");
    expect(item.key).toBe("visit:adult_physical");
    expect(item.preventiveRuleKey).toBe("adult_physical");
    expect(item.band).toBe("today");
    expect(item.dueText).toBe("Due");
    expect(item.dueDate).toBeNull();
    expect(item.href).toBe("/records#visits");
    expect(item.title).toBe("Routine adult check-up");
    // nextLabel is preferred for the detail line.
    expect(item.detail).toBe("Due now");
    // A "Book" CTA is offered, prefilling the rule's title, mapped kind, and date.
    expect(item.bookHref).toContain("/records?");
    expect(item.bookHref).toContain("new=1");
    expect(item.bookHref).toContain("kind=physical");
    expect(item.bookHref).toContain(`date=${TODAY}`);
    expect(item.scheduled).toBeUndefined();
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
      }),
      { today: TODAY }
    );
    expect(item.domain).toBe("screening");
    expect(item.key).toBe("screening:colorectal_cancer");
    expect(item.band).toBe("overdue");
    expect(item.dueText).toBe("Overdue");
    // Satisfaction-derived (issue #283): a colonoscopy-satisfied screening links
    // to the procedures surface (the removed /medical page was a dead link).
    expect(item.href).toBe("/records#procedures");
    // Falls back to detail when nextLabel is null.
    expect(item.detail).toBe("Recommended, none on record");
    expect(item.bookHref).toContain("kind=screening");
  });

  it("honors a rule-specific href override (the #83 lung prompt → Settings)", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({
        kind: "screening",
        key: "lung_cancer_ldct",
        href: "/settings/profile",
      }),
      { today: TODAY }
    );
    expect(item.href).toBe("/settings/profile");
  });

  it("uses a future next-due date as the CTA's suggested date", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({ kind: "visit", status: "due", nextDueDate: "2026-09-01" }),
      { today: TODAY }
    );
    expect(item.bookHref).toContain("date=2026-09-01");
  });

  it("flips to a quiet Scheduled state when a matching visit is booked", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({ kind: "visit", status: "overdue" }),
      { today: TODAY, scheduledDate: "2026-08-01" }
    );
    expect(item.scheduled).toBe(true);
    expect(item.dueText).toBe("Scheduled");
    // Quieted out of the nagging bands into Later, no "Book" CTA, links to the visit.
    expect(item.band).toBe("later");
    expect(item.bookHref).toBeUndefined();
    expect(item.href).toBe("/records#visits");
    expect(item.detail).toBe("Scheduled for 2026-08-01");
    // Still carries the rule key so mark-done / override remain available.
    expect(item.preventiveRuleKey).toBe("adult_physical");
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
    const items = summary.actionable.map((a) =>
      preventiveAssessmentToUpcomingItem(a, { today })
    );
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
    expect(
      summary.actionable.map((a) =>
        preventiveAssessmentToUpcomingItem(a, { today })
      )
    ).toEqual([]);
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
