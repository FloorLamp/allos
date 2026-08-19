import { describe, it, expect } from "vitest";
import {
  attentionBadgeItems,
  SETUP_GROUP_LABEL,
  buildAttentionModel,
  buildFlaggedItem,
  attentionEmphasisBandForItem,
  groupAttentionForPage,
  type AttentionInput,
} from "../attention";
import type { UpcomingItem } from "../upcoming";

const TODAY = "2026-07-10";

// A minimal UpcomingItem factory for the tests.
function up(
  partial: Partial<UpcomingItem> & Pick<UpcomingItem, "key">
): UpcomingItem {
  return {
    domain: "dose",
    title: "Item",
    href: "/training",
    dueDate: null,
    ...partial,
  } as UpcomingItem;
}

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    upcoming: [],
    flaggedBiomarkers: [],
    integrations: [],
    reviewCount: 0,
    today: TODAY,
    ...over,
  };
}

describe("buildAttentionModel — the one item builder (issue #524)", () => {
  it("empty inputs → empty model (the 'all clear' state)", () => {
    expect(buildAttentionModel(input())).toEqual([]);
  });

  it("folds the due-signals plus the flagged/integration/review signals into ONE set", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [up({ key: "dose:1", doseId: 1 })],
        flaggedBiomarkers: [
          {
            name: "LDL Cholesterol",
            canonicalName: "LDL Cholesterol",
            value: "160",
            flag: "high",
          },
        ],
        integrations: [{ id: "strava", sourceName: "Strava", detail: "401" }],
        reviewCount: 2,
      })
    );
    expect(new Set(model.map((i) => i.key))).toEqual(
      new Set([
        "dose:1",
        "biomarker-flag:ldl cholesterol",
        "integration:strava",
        "review",
      ])
    );
  });

  it("a flagged biomarker becomes an ACTION item — verb title, series deep-link, flag dismissal key, suppressible (issues #524/#526)", () => {
    const [item] = buildAttentionModel(
      input({
        flaggedBiomarkers: [
          {
            name: "HDL Cholesterol",
            canonicalName: "HDL Cholesterol",
            value: "35",
            flag: "low",
          },
        ],
      })
    );
    expect(item.key).toBe("biomarker-flag:hdl cholesterol");
    expect(item.domain).toBe("biomarker-flag");
    expect(item.signalGroup).toBe("flagged");
    // The verb up front — no more actionless "HDL Cholesterol · Flagged result 55".
    expect(item.title).toBe("Review HDL Cholesterol");
    expect(item.detail).toBe("Flagged low — 35");
    expect(item.href).toBe(
      "/results/clinical-results/view?name=HDL%20Cholesterol"
    );
    expect(item.dueText).toBe("Low");
    expect(item.suppressible).toBe(true);
    // No risk reasons passed ⇒ plain flag line + a single flagged reason.
    expect(item.reasons).toEqual([{ code: "biomarker-flagged", text: "Low" }]);
  });

  it("a risk-elevated flagged biomarker gains a why-for-this-profile line and carries the reasons (issue #656 item 4)", () => {
    const item = buildFlaggedItem(
      {
        name: "LDL Cholesterol",
        canonicalName: "LDL Cholesterol",
        value: "190",
        flag: "high",
      },
      [
        {
          code: "risk-elevated",
          text: "Family history of heart disease",
          source: "ACC/AHA (informational)",
        },
      ]
    );
    // The why-line renders after the status+value clause (detail preserved, extended).
    expect(item.detail).toBe(
      "Flagged high — 190 · Family history of heart disease"
    );
    // Structured reasons: the flag leads, the cited risk reason follows.
    expect(item.reasons).toEqual([
      { code: "biomarker-flagged", text: "High" },
      {
        code: "risk-elevated",
        text: "Family history of heart disease",
        source: "ACC/AHA (informational)",
      },
    ]);
  });

  it("an uncanonicalized flag falls back to the biomarkers list (no series link)", () => {
    const [item] = buildAttentionModel(
      input({
        flaggedBiomarkers: [
          {
            name: "Mystery Analyte",
            canonicalName: null,
            value: "5",
            flag: "abnormal",
          },
        ],
      })
    );
    expect(item.href).toBe("/results/clinical-results");
  });

  it("an out-of-range flag outranks a merely non-optimal one within its group (#517 priority)", () => {
    const model = buildAttentionModel(
      input({
        flaggedBiomarkers: [
          {
            name: "Ferritin",
            canonicalName: "Ferritin",
            value: "20",
            flag: "non-optimal-low",
          },
          {
            name: "Glucose",
            canonicalName: "Glucose",
            value: "180",
            flag: "high",
          },
        ],
      })
    );
    const [flagged] = groupAttentionForPage(model, TODAY);
    expect(flagged.kind).toBe("flagged");
    // Out-of-range (priority 1) leads the non-optimal (priority 0).
    expect(flagged.items.map((i) => i.title)).toEqual([
      "Review Glucose",
      "Review Ferritin",
    ]);
  });

  it("integration + review are structural (non-suppressible); no review item at count 0", () => {
    const model = buildAttentionModel(
      input({
        integrations: [
          {
            id: "strava",
            sourceName: "Strava",
            detail: "401 Unauthorized",
          },
        ],
        reviewCount: 3,
      })
    );
    const integ = model.find((i) => i.domain === "integration")!;
    const review = model.find((i) => i.domain === "review")!;
    expect(integ.suppressible).toBe(false);
    expect(integ.signalGroup).toBe("review");
    expect(integ.href).toBe("/integrations/strava");
    expect(review.suppressible).toBe(false);
    expect(review.title).toContain("3 import items");
    expect(
      buildAttentionModel(input({ reviewCount: 0 })).find(
        (i) => i.domain === "review"
      )
    ).toBeUndefined();
  });

  it("falls back to Review when an integration has no setup page", () => {
    const [item] = buildAttentionModel(
      input({
        integrations: [
          { id: null, sourceName: "Legacy source", detail: "Sync failed" },
        ],
      })
    );
    expect(item.key).toBe("integration:Legacy source");
    expect(item.href).toBe("/data?section=review");
  });
});

describe("groupAttentionForPage — the planning view (everything, time-ordered)", () => {
  it("bands dated items Overdue → Today → This week → Later, then Flagged, then For review", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [
          up({
            key: "appointment:1",
            domain: "appointment",
            dueDate: "2026-07-01",
          }), // overdue
          up({ key: "dose:1", domain: "dose", doseId: 1 }), // today (null date)
          up({
            key: "appointment:2",
            domain: "appointment",
            dueDate: "2026-07-14",
          }), // +4 → week
          up({
            key: "appointment:3",
            domain: "appointment",
            dueDate: "2026-08-24",
          }), // +45 → later
        ],
        flaggedBiomarkers: [
          { name: "LDL", canonicalName: "LDL", value: "160", flag: "high" },
        ],
        reviewCount: 1,
      })
    );
    const groups = groupAttentionForPage(model, TODAY);
    expect(groups.map((g) => g.kind)).toEqual([
      "overdue",
      "today",
      "week",
      "later",
      "flagged",
      "review",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Overdue",
      "Today",
      "This week",
      "Later",
      "Flagged",
      "For review",
    ]);
  });

  it("KEEPS later-band items (completeness is the point of the page)", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [
          up({
            key: "appointment:3",
            domain: "appointment",
            dueDate: "2026-08-24",
          }),
        ],
      })
    );
    const groups = groupAttentionForPage(model, TODAY);
    expect(groups.map((g) => g.kind)).toEqual(["later"]);
    expect(groups[0].items[0].key).toBe("appointment:3");
  });

  it("orders within a band by date, then #517 priority, then domain, then title", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [
          // All due 2026-07-12 (+2 → week band). Two share a date: a high-priority
          // screening must lead the routine one regardless of domain/title.
          up({
            key: "screening:a",
            domain: "screening",
            title: "Zzz screening",
            dueDate: "2026-07-12",
            priority: 3,
          }),
          up({
            key: "screening:b",
            domain: "screening",
            title: "Aaa screening",
            dueDate: "2026-07-12",
            priority: 0,
          }),
          up({
            key: "appointment:c",
            domain: "appointment",
            title: "Earlier",
            dueDate: "2026-07-11",
          }),
        ],
      })
    );
    const [week] = groupAttentionForPage(model, TODAY);
    expect(week.items.map((i) => i.key)).toEqual([
      "appointment:c", // earliest date
      "screening:a", // same date, higher priority
      "screening:b",
    ]);
  });
});

describe("the app-badge care-tier subset", () => {
  it("includes overdue, today, and review while excluding future scheduled items", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [
          up({
            key: "appointment:1",
            domain: "appointment",
            dueDate: "2026-07-01",
          }), // overdue → Urgent
          up({ key: "dose:1", domain: "dose", doseId: 1 }), // today → Today
          up({
            key: "appointment:2",
            domain: "appointment",
            dueDate: "2026-07-14",
          }), // +4 week → excluded
          up({
            key: "appointment:3",
            domain: "appointment",
            dueDate: "2026-08-24",
          }), // +45 later → excluded
        ],
        flaggedBiomarkers: [
          { name: "LDL", canonicalName: "LDL", value: "160", flag: "high" },
        ], // → Needs review
        reviewCount: 1, // → Needs review
      })
    );
    const badgeKeys = attentionBadgeItems(model, TODAY).map((item) => item.key);
    expect(badgeKeys).toEqual([
      "appointment:1",
      "dose:1",
      "biomarker-flag:ldl",
      "review",
    ]);
  });

  it("attentionEmphasisBandForItem maps overdue→urgent, today→today, signals→review, week/later→excluded", () => {
    expect(
      attentionEmphasisBandForItem(
        up({ key: "a", domain: "appointment", dueDate: "2026-07-01" }),
        TODAY
      )
    ).toBe("urgent");
    expect(
      attentionEmphasisBandForItem(
        up({ key: "b", domain: "dose", dueDate: null }),
        TODAY
      )
    ).toBe("today");
    expect(
      attentionEmphasisBandForItem(
        up({ key: "c", domain: "appointment", dueDate: "2026-07-14" }),
        TODAY
      )
    ).toBeNull();
    expect(
      attentionEmphasisBandForItem(
        up({ key: "d", domain: "appointment", dueDate: "2026-08-24" }),
        TODAY
      )
    ).toBeNull();
    expect(
      attentionEmphasisBandForItem(
        up({ key: "review", domain: "review", signalGroup: "review" }),
        TODAY
      )
    ).toBe("review");
    expect(
      attentionEmphasisBandForItem(
        up({ key: "f:x", domain: "biomarker-flag", signalGroup: "flagged" }),
        TODAY
      )
    ).toBe("review");
  });
});

// The load-bearing invariant (issue #524): the card is a strict, labeled SUBSET of
// the page's item set — every card item exists in the model with the SAME key, and
// the counts reconcile.
describe("the strict subset invariant", () => {
  const model = buildAttentionModel(
    input({
      upcoming: [
        up({
          key: "appointment:1",
          domain: "appointment",
          dueDate: "2026-07-01",
        }), // overdue
        up({ key: "dose:1", domain: "dose", doseId: 1 }), // today
        up({
          key: "appointment:2",
          domain: "appointment",
          dueDate: "2026-07-14",
        }), // week (page-only)
        up({
          key: "appointment:3",
          domain: "appointment",
          dueDate: "2026-08-24",
        }), // later (page-only)
        up({ key: "goal:1", domain: "goal", dueDate: "2026-07-20" }), // later (page-only)
      ],
      flaggedBiomarkers: [
        { name: "LDL", canonicalName: "LDL", value: "160", flag: "high" },
      ],
      integrations: [{ id: "strava", sourceName: "Strava", detail: "401" }],
      reviewCount: 4,
    })
  );

  it("every card item exists in the page model with the same key", () => {
    const modelKeys = new Set(model.map((i) => i.key));
    for (const item of attentionBadgeItems(model, TODAY)) {
      expect(modelKeys.has(item.key)).toBe(true);
    }
  });

  it("carries explicit review actions on the shared model", () => {
    expect(
      model.find((item) => item.key === "biomarker-flag:ldl")?.actionLabel
    ).toBe("Review result");
    expect(
      model.find((item) => item.key === "integration:strava")?.actionLabel
    ).toBe("Reconnect");
    expect(model.find((item) => item.key === "review")?.actionLabel).toBe(
      "Review"
    );
  });
});

// ---------------------------------------------------------------------------
// The never-recorded setup group (issue #1433)
// ---------------------------------------------------------------------------
//
// A preventive rule with nothing on record rides the shared model (so it keeps its
// dedupe key, suppression, and row affordances) but is outside the care-tier badge.
describe("never-recorded preventive setup items (#1433)", () => {
  const setupItem = (key = "screening:colorectal_cancer") =>
    up({
      key,
      domain: "screening",
      title: "Colorectal cancer screening",
      band: "later",
      signalGroup: "setup",
      dueText: "No record yet",
    });

  it("has no emphasis band, so it cannot inflate the badge or enter Now", () => {
    expect(attentionEmphasisBandForItem(setupItem(), TODAY)).toBeNull();
  });

  it("does not count toward the app badge", () => {
    const model = [
      setupItem("screening:colorectal_cancer"),
      setupItem("visit:dental_cleaning"),
      up({ key: "dose:1", doseId: 1 }),
    ];
    expect(attentionBadgeItems(model, TODAY).map((i) => i.key)).toEqual([
      "dose:1",
    ]);
  });

  it("a cold-start model of ONLY setup items reads as all clear", () => {
    const model = [
      setupItem("screening:colorectal_cancer"),
      setupItem("visit:dental_cleaning"),
      setupItem("visit:adult_physical"),
    ];
    expect(attentionBadgeItems(model, TODAY)).toEqual([]);
  });

  it("groups LAST on the Upcoming page, below everything actually due", () => {
    const groups = groupAttentionForPage(
      [
        setupItem(),
        up({ key: "appointment:1", domain: "appointment", dueDate: TODAY }),
        up({ key: "review", domain: "review", signalGroup: "review" }),
      ],
      TODAY
    );
    expect(groups.map((g) => g.kind)).toEqual(["today", "review", "setup"]);
    expect(groups.at(-1)!.label).toBe(SETUP_GROUP_LABEL);
  });
});
