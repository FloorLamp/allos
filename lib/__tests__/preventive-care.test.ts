import { describe, expect, it } from "vitest";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import {
  PREVENTIVE_CATALOG,
  preventiveRuleByKey,
  ruleScheduleSummary,
  CATALOG_REVIEWED,
} from "@/lib/preventive-catalog";
import {
  addMonths,
  applyPreventiveOverride,
  assessCatalog,
  assessPreventiveCare,
  lastByRule,
  type PreventiveAssessment,
  type PreventiveInput,
} from "@/lib/preventive-status";

const Y = 12;
const TODAY = "2026-07-10";

function assess(
  input: Partial<PreventiveInput> & { ageMonths: number | null }
) {
  return assessCatalog({
    sex: null,
    satisfactions: [],
    today: TODAY,
    ...input,
  });
}

function statusOf(key: string, s: ReturnType<typeof assessCatalog>) {
  return s.assessments.find((a) => a.key === key);
}

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------
describe("preventive catalog", () => {
  it("has unique, stable keys and a citation + review date per rule", () => {
    const keys = PREVENTIVE_CATALOG.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of PREVENTIVE_CATALOG) {
      expect(r.citation.source).toBeTruthy();
      expect(r.citation.reviewed).toMatch(/^\d{4}-\d{2}$/);
      expect(r.name).toBeTruthy();
      expect(r.kind === "visit" || r.kind === "screening").toBe(true);
    }
  });

  it("carries the well-child milestone series and the curated screenings", () => {
    for (const k of [
      "wellchild_newborn",
      "wellchild_2mo",
      "wellchild_30mo",
      "wellchild_annual",
      "adult_physical",
      "dental_cleaning",
      "colorectal_cancer",
      "mammography",
      "cervical_cancer",
      "blood_pressure",
      "lipid_screening",
      "diabetes_screening",
      "osteoporosis",
      "hepatitis_c",
      "lung_cancer_ldct",
      "aaa_ultrasound",
    ]) {
      expect(preventiveRuleByKey(k), k).toBeTruthy();
    }
  });

  it("summarizes each schedule shape", () => {
    expect(ruleScheduleSummary(preventiveRuleByKey("wellchild_2mo")!)).toMatch(
      /2 mo/
    );
    expect(
      ruleScheduleSummary(preventiveRuleByKey("dental_cleaning")!)
    ).toMatch(/Every 6 months/);
    expect(
      ruleScheduleSummary(preventiveRuleByKey("colorectal_cancer")!)
    ).toMatch(/Ages 45–76/);
    expect(CATALOG_REVIEWED).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Missing demographics — emit nothing / no guesses
// ---------------------------------------------------------------------------
describe("missing demographics", () => {
  it("emits nothing when age is unknown", () => {
    const s = assess({ ageMonths: null });
    expect(s.assessments).toEqual([]);
    expect(s.actionable).toEqual([]);
    expect(s.dueCount).toBe(0);
    expect(s.overdueCount).toBe(0);
  });

  it("omits sex-restricted rules when sex is unknown (no guess)", () => {
    const s = assess({ ageMonths: 50 * Y, sex: null });
    for (const k of [
      "mammography",
      "cervical_cancer",
      "osteoporosis",
      "aaa_ultrasound",
    ]) {
      expect(statusOf(k, s), k).toBeUndefined();
    }
    // A non-sex rule is still assessed.
    expect(statusOf("colorectal_cancer", s)).toBeTruthy();
  });

  it("marks a sex-mismatched rule not_recommended when sex is known", () => {
    const s = assess({ ageMonths: 50 * Y, sex: "male" });
    expect(statusOf("mammography", s)?.status).toBe("not_recommended");
  });
});

// ---------------------------------------------------------------------------
// Well-child milestone windows (month granularity, lead, grace, lapse)
// ---------------------------------------------------------------------------
describe("well-child milestone windows", () => {
  // wellchild_2mo: at 2, end 4, grace 1 → lead opens at 1, overdue at 3, lapses at 4.
  it("is a future (up_to_date) item before the lead window", () => {
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 0 }))?.status).toBe(
      "up_to_date"
    );
  });
  it("is due from one month before target through the grace edge", () => {
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 1 }))?.status).toBe(
      "due"
    );
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 2 }))?.status).toBe(
      "due"
    );
  });
  it("becomes overdue at target + grace, until the window closes", () => {
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 3 }))?.status).toBe(
      "overdue"
    );
  });
  it("lapses to not_recommended once past the window (next milestone takes over)", () => {
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 4 }))?.status).toBe(
      "not_recommended"
    );
    expect(statusOf("wellchild_2mo", assess({ ageMonths: 60 }))?.status).toBe(
      "not_recommended"
    );
  });
  it("is up_to_date once a satisfaction is recorded", () => {
    const s = assess({
      ageMonths: 3,
      satisfactions: [{ ruleKey: "wellchild_2mo", date: "2026-06-01" }],
    });
    expect(statusOf("wellchild_2mo", s)?.status).toBe("up_to_date");
    expect(statusOf("wellchild_2mo", s)?.lastDate).toBe("2026-06-01");
  });

  it("resolves month granularity through ageInMonthsFromBirthdate (one-day edge)", () => {
    // wellchild_4mo: lead opens at age 3 months.
    const at3 = ageInMonthsFromBirthdate("2026-04-10", TODAY); // exactly 3 months
    const almost3 = ageInMonthsFromBirthdate("2026-04-11", TODAY); // 2 months + 29 days
    expect(at3).toBe(3);
    expect(almost3).toBe(2);
    expect(statusOf("wellchild_4mo", assess({ ageMonths: at3 }))?.status).toBe(
      "due"
    );
    expect(
      statusOf("wellchild_4mo", assess({ ageMonths: almost3 }))?.status
    ).toBe("up_to_date");
  });
});

// ---------------------------------------------------------------------------
// Screening age windows (never done → due vs overdue vs aged-out)
// ---------------------------------------------------------------------------
describe("screening age windows (never done)", () => {
  // colorectal_cancer: 45–76, grace 6 → lead opens at 45y-1mo, overdue at 45y6mo, aged out at 76y.
  it("is not_recommended before the lead window", () => {
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 45 * Y - 2 }))?.status
    ).toBe("not_recommended");
  });
  it("is due at the window edge (and ~1 month before)", () => {
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 45 * Y - 1 }))?.status
    ).toBe("due");
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 45 * Y }))?.status
    ).toBe("due");
  });
  it("becomes overdue past the grace period with nothing on record", () => {
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 45 * Y + 6 }))?.status
    ).toBe("overdue");
  });
  it("is not_recommended once aged out of the routine window", () => {
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 76 * Y }))?.status
    ).toBe("not_recommended");
    expect(
      statusOf("colorectal_cancer", assess({ ageMonths: 75 * Y }))?.status
    ).not.toBe("not_recommended");
  });
});

// ---------------------------------------------------------------------------
// Interval recurrence (clock from the last result)
// ---------------------------------------------------------------------------
describe("interval recurrence from last result", () => {
  // blood_pressure: interval 12mo, grace 6. Adult (40y) so it's in-window.
  const age = 40 * Y;
  it("is up_to_date before the lead window opens", () => {
    const s = assess({
      ageMonths: age,
      satisfactions: [{ ruleKey: "blood_pressure", date: "2025-07-10" }],
      today: "2026-05-01",
    });
    const a = statusOf("blood_pressure", s)!;
    expect(a.status).toBe("up_to_date");
    expect(a.nextDueDate).toBe("2026-07-10");
  });
  it("is due within a month of the due date and up to the grace period", () => {
    const s = assess({
      ageMonths: age,
      satisfactions: [{ ruleKey: "blood_pressure", date: "2025-07-10" }],
      today: "2026-07-10",
    });
    expect(statusOf("blood_pressure", s)?.status).toBe("due");
  });
  it("is overdue past the interval + grace", () => {
    const s = assess({
      ageMonths: age,
      satisfactions: [{ ruleKey: "blood_pressure", date: "2025-07-10" }],
      today: "2027-02-01",
    });
    const a = statusOf("blood_pressure", s)!;
    expect(a.status).toBe("overdue");
    expect(a.nextDueDate).toBe("2026-07-10");
  });
  it("keeps only the most recent satisfaction as the clock anchor", () => {
    const s = assess({
      ageMonths: age,
      satisfactions: [
        { ruleKey: "blood_pressure", date: "2020-01-01" },
        { ruleKey: "blood_pressure", date: "2026-06-01" },
      ],
      today: "2026-07-10",
    });
    expect(statusOf("blood_pressure", s)?.lastDate).toBe("2026-06-01");
    expect(statusOf("blood_pressure", s)?.status).toBe("up_to_date");
  });
});

// ---------------------------------------------------------------------------
// One-time (once-in-window) screening
// ---------------------------------------------------------------------------
describe("one-time screening (hepatitis C)", () => {
  it("is due when freshly in-window and never done", () => {
    expect(statusOf("hepatitis_c", assess({ ageMonths: 18 * Y }))?.status).toBe(
      "due"
    );
  });
  it("is overdue when well past entry with nothing on record", () => {
    expect(statusOf("hepatitis_c", assess({ ageMonths: 40 * Y }))?.status).toBe(
      "overdue"
    );
  });
  it("stays satisfied for good once a result exists", () => {
    const s = assess({
      ageMonths: 40 * Y,
      satisfactions: [{ ruleKey: "hepatitis_c", date: "2015-01-01" }],
    });
    expect(statusOf("hepatitis_c", s)?.status).toBe("up_to_date");
  });
});

// ---------------------------------------------------------------------------
// Sex gating
// ---------------------------------------------------------------------------
describe("sex gating", () => {
  it("recommends a female-only screening for a matching profile", () => {
    // At the window entry age (40y) with nothing on record → due (not yet overdue).
    expect(
      statusOf("mammography", assess({ ageMonths: 40 * Y, sex: "female" }))
        ?.status
    ).toBe("due");
  });
  it("does not recommend a female-only screening for a male profile", () => {
    expect(
      statusOf("mammography", assess({ ageMonths: 45 * Y, sex: "male" }))
        ?.status
    ).toBe("not_recommended");
  });
  it("gates osteoporosis to women 65+", () => {
    expect(
      statusOf("osteoporosis", assess({ ageMonths: 65 * Y, sex: "female" }))
        ?.status
    ).toBe("due");
    expect(
      statusOf("osteoporosis", assess({ ageMonths: 60 * Y, sex: "female" }))
        ?.status
    ).toBe("not_recommended");
  });
});

// ---------------------------------------------------------------------------
// Risk-gated rules stay inert
// ---------------------------------------------------------------------------
describe("risk-gated rules", () => {
  it("never fires when no smoking input is resolved (default inert)", () => {
    // A 70y male matches AAA's age/sex, yet it stays not_recommended.
    expect(
      statusOf("aaa_ultrasound", assess({ ageMonths: 70 * Y, sex: "male" }))
        ?.status
    ).toBe("not_recommended");
    expect(
      statusOf("lung_cancer_ldct", assess({ ageMonths: 60 * Y }))?.status
    ).toBe("not_recommended");
  });

  // Smoking activates the two risk-gated screenings (issue #83). The smoking facts
  // come pre-resolved (lib/smoking.resolveSmoking); the assessor consumes them.
  const everSmoker = {
    status: "former" as const,
    packYears: 30,
    quitYear: 2020,
    everSmoked: true,
    source: "structured" as const,
  };

  it("AAA fires (becomes actionable) for an ever-smoker in the age/sex window", () => {
    const s = assess({
      ageMonths: 70 * Y,
      sex: "male",
      smoking: everSmoker,
    });
    // Never done + well past the 65y entry age → actionable (overdue here).
    expect(["due", "overdue"]).toContain(statusOf("aaa_ultrasound", s)?.status);
    expect(s.actionable.some((a) => a.key === "aaa_ultrasound")).toBe(true);
  });

  it("AAA stays inert for a never-smoker even in the window", () => {
    const s = assess({
      ageMonths: 70 * Y,
      sex: "male",
      smoking: {
        status: "never",
        packYears: null,
        quitYear: null,
        everSmoked: false,
        source: "structured",
      },
    });
    expect(statusOf("aaa_ultrasound", s)?.status).toBe("not_recommended");
  });

  it("AAA respects the age gate — no smoking prompt for a 40y ever-smoker", () => {
    const s = assess({
      ageMonths: 40 * Y,
      sex: "male",
      smoking: everSmoker,
    });
    expect(statusOf("aaa_ultrasound", s)?.status).toBe("not_recommended");
  });

  it("lung LDCT fires for a qualifying smoker (≥20 pack-years, quit <15y)", () => {
    const s = assess({
      ageMonths: 60 * Y,
      smoking: everSmoker, // quit 2020, today 2026 → 6y ago
    });
    // Never done + past the 50y entry age → actionable (overdue here).
    expect(["due", "overdue"]).toContain(
      statusOf("lung_cancer_ldct", s)?.status
    );
    expect(s.actionable.some((a) => a.key === "lung_cancer_ldct")).toBe(true);
  });

  it("lung LDCT stays inert below the pack-year threshold", () => {
    const s = assess({
      ageMonths: 60 * Y,
      smoking: { ...everSmoker, packYears: 10 },
    });
    expect(statusOf("lung_cancer_ldct", s)?.status).toBe("not_recommended");
  });

  it("lung LDCT stays inert for a former smoker who quit > 15y ago", () => {
    const s = assess({
      ageMonths: 60 * Y,
      smoking: { ...everSmoker, quitYear: 2000 },
    });
    expect(statusOf("lung_cancer_ldct", s)?.status).toBe("not_recommended");
  });

  it("lung LDCT PROMPTS an imported-only ever-smoker to add pack-years", () => {
    const s = assess({
      ageMonths: 60 * Y,
      smoking: {
        status: null,
        packYears: null,
        quitYear: null,
        everSmoked: true,
        source: "imported",
      },
    });
    const a = statusOf("lung_cancer_ldct", s)!;
    expect(a.status).toBe("due");
    expect(a.href).toBe("/settings/profile");
    expect(a.detail).toMatch(/pack-years/i);
  });

  it("age gate still wins — a 40y qualifying smoker gets no lung prompt", () => {
    const s = assess({
      ageMonths: 40 * Y,
      smoking: everSmoker,
    });
    expect(statusOf("lung_cancer_ldct", s)?.status).toBe("not_recommended");
  });
});

// ---------------------------------------------------------------------------
// Overrides (declined / not_applicable)
// ---------------------------------------------------------------------------
describe("overrides", () => {
  it("declined drops the item out of the actionable set", () => {
    const s = assess({
      ageMonths: 45 * Y,
      sex: "female",
      overrides: [{ ruleKey: "cervical_cancer", kind: "declined" }],
    });
    const a = statusOf("cervical_cancer", s)!;
    expect(a.status).toBe("not_recommended");
    expect(a.override).toBe("declined");
    expect(
      s.actionable.find((x) => x.key === "cervical_cancer")
    ).toBeUndefined();
  });
  it("not_applicable is the anatomy escape hatch", () => {
    const s = assess({
      ageMonths: 45 * Y,
      sex: "female",
      overrides: [{ ruleKey: "cervical_cancer", kind: "not_applicable" }],
    });
    const a = statusOf("cervical_cancer", s)!;
    expect(a.status).toBe("not_recommended");
    expect(a.override).toBe("not_applicable");
  });
  it("applyPreventiveOverride is a no-op without a matching override", () => {
    const base: PreventiveAssessment = {
      key: "x",
      name: "X",
      kind: "screening",
      status: "due",
      lastDate: null,
      nextDueDate: null,
      nextDueAgeMonths: null,
      detail: "",
      nextLabel: null,
      href: null,
      override: null,
      citation: { source: "s", summary: "", reviewed: "2026-07" },
    };
    expect(applyPreventiveOverride(base, undefined)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Summary shape (counts + ordering)
// ---------------------------------------------------------------------------
describe("summary shape", () => {
  it("counts due/overdue and orders overdue before due in actionable", () => {
    const s = assess({ ageMonths: 50 * Y, sex: "female" });
    expect(s.dueCount + s.overdueCount).toBe(s.actionable.length);
    const firstDue = s.actionable.findIndex((a) => a.status === "due");
    const lastOverdue = s.actionable
      .map((a) => a.status)
      .lastIndexOf("overdue");
    if (firstDue !== -1 && lastOverdue !== -1) {
      expect(lastOverdue).toBeLessThan(firstDue);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("addMonths", () => {
  it("adds months and clamps to the target month's last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-07-10", -1)).toBe("2026-06-10");
    expect(addMonths("2026-07-10", 12)).toBe("2027-07-10");
  });
  it("returns the input unchanged when unparseable", () => {
    expect(addMonths("not-a-date", 3)).toBe("not-a-date");
  });
});

describe("lastByRule", () => {
  it("keeps the latest date per rule key", () => {
    const m = lastByRule([
      { ruleKey: "a", date: "2020-01-01" },
      { ruleKey: "a", date: "2024-06-01" },
      { ruleKey: "b", date: "2022-03-03" },
      { ruleKey: "b", date: "" },
    ]);
    expect(m.get("a")).toBe("2024-06-01");
    expect(m.get("b")).toBe("2022-03-03");
  });
});

describe("assessPreventiveCare with a custom rule list", () => {
  it("assesses only the rules passed in", () => {
    const rule = preventiveRuleByKey("colorectal_cancer")!;
    const s = assessPreventiveCare([rule], {
      ageMonths: 50 * Y,
      sex: "male",
      satisfactions: [],
      today: TODAY,
    });
    expect(s.assessments).toHaveLength(1);
    expect(s.assessments[0].key).toBe("colorectal_cancer");
  });
});
