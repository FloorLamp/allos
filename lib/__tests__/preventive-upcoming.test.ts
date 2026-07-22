import { describe, it, expect } from "vitest";
import {
  preventiveAssessmentToUpcomingItem,
  preventiveHref,
  preventiveActionLabel,
  preventiveNudgeAction,
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

// The per-class deep link + CTA, driven by each rule's `satisfiedBy` concept (#1083).
// Both preventiveHref (title link) and preventiveActionLabel (CTA copy) are pinned so
// the page, the Upcoming row, and the nudge stay in lockstep (#221).
describe("preventiveHref — per-class deep link from satisfiedBy (#1083)", () => {
  it("visits act through the appointments surface (Book is their CTA)", () => {
    expect(preventiveHref("visit", "adult_physical")).toBe(
      "/records/history/visits"
    );
    expect(preventiveHref("visit", "dental_cleaning")).toBe(
      "/records/history/visits"
    );
  });

  it("lab → the biomarker add-form prefilled with the canonical (#662, NOT #biomarkers)", () => {
    expect(preventiveHref("screening", "lipid_screening")).toBe(
      "/results/biomarkers?new=1&name=LDL%20Cholesterol"
    );
    expect(preventiveHref("screening", "diabetes_screening")).toBe(
      "/results/biomarkers?new=1&name=Hemoglobin%20A1c"
    );
  });

  it("lab with no tracked biomarker → the add form, unprefilled", () => {
    expect(preventiveHref("screening", "hepatitis_c")).toBe(
      "/results/biomarkers?new=1"
    );
  });

  it("vital (blood pressure) → the vitals entry surface, NOT the biomarkers form (#1076)", () => {
    expect(preventiveHref("screening", "blood_pressure")).toBe(
      "/trends?tab=vitals&focus=blood-pressure"
    );
  });

  it("instrument in-app → the instrument page with ?screen=<INSTRUMENT>", () => {
    expect(preventiveHref("screening", "depression_screening")).toBe(
      "/records/specialty/mental-health?screen=PHQ-9"
    );
    expect(preventiveHref("screening", "anxiety_screening")).toBe(
      "/records/specialty/mental-health?screen=GAD-7"
    );
    expect(preventiveHref("screening", "alcohol_screening")).toBe(
      "/medical/substance-use?screen=AUDIT-C"
    );
  });

  it("instrument total-only → the SAME ?screen= link (form focuses total entry)", () => {
    expect(preventiveHref("screening", "drug_use_screening")).toBe(
      "/medical/substance-use?screen=DAST-10"
    );
  });

  it("procedure → the procedures add-form prefilled with the procedure noun", () => {
    expect(preventiveHref("screening", "colorectal_cancer")).toBe(
      "/records/history/procedures?new=1&name=Colonoscopy"
    );
    expect(preventiveHref("screening", "osteoporosis")).toBe(
      "/records/history/procedures?new=1&name=DEXA%20scan"
    );
    expect(preventiveHref("screening", "mammography")).toBe(
      "/records/history/procedures?new=1&name=Mammogram"
    );
  });

  it("falls back to the passport for a rule the concept map can't satisfy", () => {
    // Manual-only rules (e.g. the risk-gated lung LDCT) have no concept-map
    // entry; their completion is recorded on the passport.
    expect(preventiveHref("screening", "lung_cancer_ldct")).toBe("/profile");
  });
});

describe("preventiveActionLabel — named CTA per class (#1083)", () => {
  it("instrument in-app → Complete the …", () => {
    expect(preventiveActionLabel("screening", "alcohol_screening")).toBe(
      "Complete the AUDIT-C"
    );
    expect(preventiveActionLabel("screening", "depression_screening")).toBe(
      "Complete the PHQ-9"
    );
  });

  it("instrument total-only → Enter your … score (can't be administered in-app)", () => {
    expect(preventiveActionLabel("screening", "drug_use_screening")).toBe(
      "Enter your DAST-10 score"
    );
  });

  it("lab → Record your … result", () => {
    expect(preventiveActionLabel("screening", "lipid_screening")).toBe(
      "Record your LDL Cholesterol result"
    );
    expect(preventiveActionLabel("screening", "hepatitis_c")).toBe(
      "Record your result"
    );
  });

  it("vital → Record a blood pressure reading", () => {
    expect(preventiveActionLabel("screening", "blood_pressure")).toBe(
      "Record a blood pressure reading"
    );
  });

  it("procedure → Log or schedule a …", () => {
    expect(preventiveActionLabel("screening", "colorectal_cancer")).toBe(
      "Log or schedule a Colonoscopy"
    );
  });

  it("null for a visit (Book is its CTA) and for an unmapped rule", () => {
    expect(preventiveActionLabel("visit", "adult_physical")).toBeNull();
    expect(preventiveActionLabel("screening", "lung_cancer_ldct")).toBeNull();
  });
});

// The row builder AND the nudge builder both read the same functions above, so every
// class emits BOTH a deep link and a named CTA that agree across surfaces (#221).
describe("preventiveNudgeAction — shared link+CTA for the nudge (#1083/#221)", () => {
  it("a screening yields its deep link + named CTA (same as the row's href/actionLabel)", () => {
    const a = mkAssessment({
      kind: "screening",
      key: "drug_use_screening",
      name: "Drug use screening",
    });
    const nudge = preventiveNudgeAction(a, TODAY)!;
    const row = preventiveAssessmentToUpcomingItem(a, { today: TODAY });
    expect(nudge.href).toBe("/medical/substance-use?screen=DAST-10");
    expect(nudge.label).toBe("Enter your DAST-10 score");
    // Row and nudge agree — one computation, no hand-mirroring.
    expect(nudge.href).toBe(row.href);
    expect(nudge.label).toBe(row.actionLabel);
  });

  it("a visit yields the prefilled Book path + Book CTA", () => {
    const a = mkAssessment({
      kind: "visit",
      key: "vision_exam",
      name: "Eye exam",
    });
    const nudge = preventiveNudgeAction(a, TODAY)!;
    expect(nudge.label).toBe("Book");
    expect(nudge.href).toContain("/records/history/visits?");
    expect(nudge.href).toContain("new=1");
  });

  it("null for an unmapped rule (no concrete next action to link/name)", () => {
    expect(
      preventiveNudgeAction(
        mkAssessment({ kind: "screening", key: "lung_cancer_ldct" }),
        TODAY
      )
    ).toBeNull();
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
    expect(item.href).toBe("/records/history/visits");
    expect(item.title).toBe("Routine adult check-up");
    // nextLabel is preferred for the detail line.
    expect(item.detail).toBe("Due now");
    // A "Book" CTA is offered, prefilling the rule's title, mapped kind, and date.
    expect(item.bookHref).toContain("/records/history/visits?");
    expect(item.bookHref).toContain("new=1");
    expect(item.bookHref).toContain("kind=physical");
    expect(item.bookHref).toContain(`date=${TODAY}`);
    // A visit's action is Book — it carries no separate screening CTA.
    expect(item.actionLabel).toBeUndefined();
    expect(item.scheduled).toBeUndefined();
  });

  it("maps an overdue SCREENING to a deep link + named CTA (procedure class)", () => {
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
    // Deep link to the concrete action (#1083): the prefilled procedures add form,
    // NOT a browse list.
    expect(item.href).toBe(
      "/records/history/procedures?new=1&name=Colonoscopy"
    );
    expect(item.actionLabel).toBe("Log or schedule a Colonoscopy");
    // Falls back to detail when nextLabel is null.
    expect(item.detail).toBe("Recommended, none on record");
    expect(item.bookHref).toContain("kind=screening");
  });

  it("every screening class emits BOTH a deep link and a named CTA", () => {
    const cases: Array<[string, string, string]> = [
      // key, expected href, expected CTA
      [
        "lipid_screening",
        "/results/biomarkers?new=1&name=LDL%20Cholesterol",
        "Record your LDL Cholesterol result",
      ],
      [
        "blood_pressure",
        "/trends?tab=vitals&focus=blood-pressure",
        "Record a blood pressure reading",
      ],
      [
        "alcohol_screening",
        "/medical/substance-use?screen=AUDIT-C",
        "Complete the AUDIT-C",
      ],
      [
        "drug_use_screening",
        "/medical/substance-use?screen=DAST-10",
        "Enter your DAST-10 score",
      ],
    ];
    for (const [key, href, cta] of cases) {
      const item = preventiveAssessmentToUpcomingItem(
        mkAssessment({ kind: "screening", key, name: key }),
        { today: TODAY }
      );
      expect(item.href, `${key} href`).toBe(href);
      expect(item.actionLabel, `${key} cta`).toBe(cta);
    }
  });

  it("honors a rule-specific href override (the #83 lung prompt → Settings), no CTA", () => {
    const item = preventiveAssessmentToUpcomingItem(
      mkAssessment({
        kind: "screening",
        key: "lung_cancer_ldct",
        href: "/settings/profile",
      }),
      { today: TODAY }
    );
    expect(item.href).toBe("/settings/profile");
    // An overridden href points elsewhere, so the default screening CTA is moot.
    expect(item.actionLabel).toBeUndefined();
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
    expect(item.href).toBe("/records/history/visits");
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
