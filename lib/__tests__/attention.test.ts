import { describe, it, expect } from "vitest";
import {
  ATTENTION_CARD_CAP,
  attentionCardItems,
  attentionCountLabel,
  buildAttentionModel,
  buildFlaggedItem,
  cardBandForItem,
  groupAttentionForCard,
  groupAttentionForPage,
  moreInUpcomingCount,
  planAttentionMoreLinks,
  CARD_BAND_ORDER,
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
        integrations: [{ id: "strava", provider: "Strava", detail: "401" }],
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
    expect(item.href).toBe("/biomarkers/view?name=HDL%20Cholesterol");
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
    expect(item.href).toBe("/biomarkers");
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
            provider: "Strava",
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
          { id: null, provider: "Legacy source", detail: "Sync failed" },
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

describe("groupAttentionForCard — the triage glance (act-now subset)", () => {
  it("bands Urgent / Today / Needs review and EXCLUDES this-week + later scheduled items", () => {
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
    const groups = groupAttentionForCard(model, TODAY);
    expect(groups.map((g) => g.band)).toEqual(["urgent", "today", "review"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Past due",
      "Today",
      "Needs review",
    ]);
    // The week/later scheduled appointments are NOT on the card.
    const cardKeys = groups.flatMap((g) => g.items.map((i) => i.key));
    expect(cardKeys).not.toContain("appointment:2");
    expect(cardKeys).not.toContain("appointment:3");
    // Both signals land in Needs review.
    const review = groups.find((g) => g.band === "review")!;
    expect(review.items.map((i) => i.key).sort()).toEqual([
      "biomarker-flag:ldl",
      "review",
    ]);
  });

  it("cardBandForItem maps overdue→urgent, today→today, signals→review, week/later→excluded", () => {
    expect(
      cardBandForItem(
        up({ key: "a", domain: "appointment", dueDate: "2026-07-01" }),
        TODAY
      )
    ).toBe("urgent");
    expect(
      cardBandForItem(up({ key: "b", domain: "dose", dueDate: null }), TODAY)
    ).toBe("today");
    expect(
      cardBandForItem(
        up({ key: "c", domain: "appointment", dueDate: "2026-07-14" }),
        TODAY
      )
    ).toBeNull();
    expect(
      cardBandForItem(
        up({ key: "d", domain: "appointment", dueDate: "2026-08-24" }),
        TODAY
      )
    ).toBeNull();
    expect(
      cardBandForItem(
        up({ key: "review", domain: "review", signalGroup: "review" }),
        TODAY
      )
    ).toBe("review");
    expect(
      cardBandForItem(
        up({ key: "f:x", domain: "biomarker-flag", signalGroup: "flagged" }),
        TODAY
      )
    ).toBe("review");
  });

  it("caps the whole card and reports the rest as overflow (issue #283)", () => {
    const model = buildAttentionModel(
      input({
        upcoming: Array.from({ length: 12 }, (_, i) =>
          up({
            key: `appointment:${i}`,
            domain: "appointment",
            title: `Visit ${String(i).padStart(2, "0")}`,
            dueDate: "2026-07-01",
          })
        ),
      })
    );
    const [group] = groupAttentionForCard(model, TODAY);
    expect(group.band).toBe("urgent");
    expect(group.items).toHaveLength(ATTENTION_CARD_CAP);
    expect(group.overflow).toBe(12 - ATTENTION_CARD_CAP);
    expect(group.items[0].title).toBe("Visit 00");
    const [tight] = groupAttentionForCard(model, TODAY, 2);
    expect(tight.items).toHaveLength(2);
    expect(tight.overflow).toBe(10);
  });

  it("keeps every populated band represented inside the total cap", () => {
    const model = buildAttentionModel(
      input({
        upcoming: [
          ...Array.from({ length: 10 }, (_, i) =>
            up({
              key: `appointment:${i}`,
              domain: "appointment",
              dueDate: "2026-07-01",
            })
          ),
          up({ key: "dose:1", domain: "dose", dueDate: TODAY }),
        ],
        reviewCount: 1,
      })
    );
    const groups = groupAttentionForCard(model, TODAY, 4);
    expect(groups.flatMap((g) => g.items)).toHaveLength(4);
    expect(groups.map((g) => g.band)).toEqual(["urgent", "today", "review"]);
    expect(groups.find((g) => g.band === "urgent")?.items).toHaveLength(2);
  });

  it("card bands come back in fixed Past due → Today → Needs review order", () => {
    expect(CARD_BAND_ORDER).toEqual(["urgent", "today", "review"]);
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
      integrations: [{ id: "strava", provider: "Strava", detail: "401" }],
      reviewCount: 4,
    })
  );

  it("every card item exists in the page model with the same key", () => {
    const modelKeys = new Set(model.map((i) => i.key));
    for (const item of attentionCardItems(model, TODAY)) {
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

  it("card count + 'more in Upcoming' reconciles to the page total", () => {
    const card = attentionCardItems(model, TODAY);
    const cardCount = card.length;
    const more = moreInUpcomingCount(model, cardCount);
    // The page's total is the whole model; the card's count plus the hidden
    // far-future items equals it exactly.
    expect(cardCount + more).toBe(model.length);
    // The hidden set is precisely the week/later scheduled items the card omits.
    expect(more).toBe(3); // appointment:2 (week) + appointment:3 (later) + goal:1 (later)
  });
});

// Issue #512 — the honest per-band count label + the card/page reconciliation.
describe("count helpers", () => {
  it("attentionCountLabel: plain count with no overflow, 'shown of total' when capped", () => {
    expect(attentionCountLabel(5, 0)).toBe("5");
    expect(attentionCountLabel(8, 3)).toBe("8 of 11");
  });

  it("moreInUpcomingCount never goes negative", () => {
    expect(moreInUpcomingCount([], 0)).toBe(0);
    expect(moreInUpcomingCount([up({ key: "a" })], 5)).toBe(0);
  });
});

// Issue #538 — the two kinds of "+N more" link must be told apart by what they
// point at (the #531 convention), never by vertical position, and must never stack
// as two identical-looking links.
describe("planAttentionMoreLinks — disambiguated '+N more' copy (issue #538)", () => {
  it("a non-last band's cap overflow names its own band and deep-links to that band anchor", () => {
    const { perBand, trailing } = planAttentionMoreLinks(
      [
        { band: "urgent", overflow: 1 },
        { band: "today", overflow: 0 },
      ],
      0
    );
    expect(perBand.urgent).toEqual({
      count: 1,
      text: "+1 more overdue in Upcoming",
      href: "/upcoming#overdue",
    });
    expect(perBand.today).toBeUndefined();
    expect(trailing).toBeNull();
  });

  it("the card remainder alone names what it HIDES ('scheduled later') and links to the Later section", () => {
    const { perBand, trailing } = planAttentionMoreLinks(
      [{ band: "urgent", overflow: 0 }],
      4
    );
    expect(perBand).toEqual({});
    expect(trailing).toEqual({
      count: 4,
      text: "+4 scheduled later — view all in Upcoming",
      href: "/upcoming#later",
    });
  });

  it("MERGES the last band's overflow with the remainder into ONE line so two links never stack", () => {
    // The exact #538 report: the last (only) band overflows by 1 AND 4 far-future
    // items are hidden — two adjacent "+N more in Upcoming" links. They collapse to
    // a single, self-describing line.
    const { perBand, trailing } = planAttentionMoreLinks(
      [{ band: "urgent", overflow: 1 }],
      4
    );
    // The last band's own overflow link is withheld — it's folded into `trailing`.
    expect(perBand.urgent).toBeUndefined();
    expect(trailing).toEqual({
      count: 5,
      text: "+1 more overdue and 4 scheduled later in Upcoming",
      href: "/upcoming",
    });
  });

  it("only the LAST band merges: an earlier band still renders its own link alongside the merged trailing line", () => {
    const { perBand, trailing } = planAttentionMoreLinks(
      [
        { band: "urgent", overflow: 2 },
        { band: "review", overflow: 3 },
      ],
      4
    );
    // The urgent band isn't adjacent to the remainder, so it keeps its own link.
    expect(perBand.urgent).toEqual({
      count: 2,
      text: "+2 more overdue in Upcoming",
      href: "/upcoming#overdue",
    });
    // The review band is last and overflows, so it merges with the remainder.
    expect(perBand.review).toBeUndefined();
    expect(trailing).toEqual({
      count: 7,
      text: "+3 more to review and 4 scheduled later in Upcoming",
      href: "/upcoming",
    });
  });

  it("the review band spans two page groupings, so its overflow link carries no misleading anchor", () => {
    const { perBand } = planAttentionMoreLinks(
      [{ band: "review", overflow: 2 }],
      0
    );
    expect(perBand.review).toEqual({
      count: 2,
      text: "+2 more to review in Upcoming",
      href: "/upcoming",
    });
  });

  it("no overflow and no remainder → no links at all", () => {
    expect(planAttentionMoreLinks([{ band: "today", overflow: 0 }], 0)).toEqual(
      { perBand: {}, trailing: null }
    );
    expect(planAttentionMoreLinks([], 0)).toEqual({
      perBand: {},
      trailing: null,
    });
  });
});
