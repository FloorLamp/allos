import { describe, expect, it } from "vitest";
import {
  matchTier,
  sortHits,
  rankAndGroup,
  flattenHits,
  SEARCH_DOMAIN_ORDER,
  SEARCH_DOMAIN_LABELS,
  type SearchDomain,
  type SearchHit,
} from "@/lib/search-rank";

function hit(over: Partial<SearchHit> & Pick<SearchHit, "title">): SearchHit {
  return {
    domain: "clinical-result",
    key: `k:${over.title}`,
    subtitle: null,
    href: "/training",
    date: null,
    ...over,
  };
}

describe("matchTier", () => {
  it("ranks exact > prefix > substring > none", () => {
    expect(matchTier("Glucose", "glucose")).toBe(3);
    expect(matchTier("Glucose", "glu")).toBe(2);
    expect(matchTier("Fasting Glucose", "glucose")).toBe(1);
    expect(matchTier("Glucose", "insulin")).toBe(0);
  });

  it("is case- and edge-whitespace-insensitive", () => {
    expect(matchTier("  Vitamin D  ", "vitamin d")).toBe(3);
    expect(matchTier("Vitamin D", "  VIT")).toBe(2);
  });

  it("treats an empty query (or empty text) as no match", () => {
    expect(matchTier("anything", "")).toBe(0);
    expect(matchTier("", "q")).toBe(0);
  });
});

describe("sortHits", () => {
  it("orders by match tier first", () => {
    const out = sortHits(
      [
        hit({ title: "Total Cholesterol" }), // substring (1)
        hit({ title: "Cholesterol" }), // exact (3)
        hit({ title: "Cholesterol Ratio" }), // prefix (2)
      ],
      "cholesterol"
    );
    expect(out.map((h) => h.title)).toEqual([
      "Cholesterol",
      "Cholesterol Ratio",
      "Total Cholesterol",
    ]);
  });

  it("breaks ties on recency, newest first, undated last", () => {
    const out = sortHits(
      [
        hit({ title: "Glucose", key: "a", date: "2024-01-01" }),
        hit({ title: "Glucose", key: "b", date: "2026-05-01" }),
        hit({ title: "Glucose", key: "c", date: null }),
      ],
      "glucose"
    );
    expect(out.map((h) => h.key)).toEqual(["b", "a", "c"]);
  });

  it("is stable/deterministic on full ties (title then key)", () => {
    const out = sortHits(
      [
        hit({ title: "B", key: "k2" }),
        hit({ title: "A", key: "k3" }),
        hit({ title: "A", key: "k1" }),
      ],
      "a"
    );
    // "B" is a non-match (tier 0) but still ordered deterministically after A's.
    expect(out.map((h) => h.key)).toEqual(["k1", "k3", "k2"]);
  });

  it("does not mutate its input", () => {
    const input = [hit({ title: "Z" }), hit({ title: "A" })];
    const copy = [...input];
    sortHits(input, "a");
    expect(input).toEqual(copy);
  });
});

describe("rankAndGroup", () => {
  it("groups by domain in the fixed order, dropping empty domains", () => {
    const groups = rankAndGroup(
      [
        hit({ domain: "goal", title: "Run a marathon", key: "g1" }),
        hit({ domain: "clinical-result", title: "HDL", key: "b1" }),
        hit({ domain: "page", title: "Settings", key: "p1" }),
      ],
      ""
    );
    expect(groups.map((g) => g.domain)).toEqual([
      "clinical-result",
      "goal",
      "page",
    ]);
    // Order matches the canonical domain order.
    const idx = (d: string) => SEARCH_DOMAIN_ORDER.indexOf(d as never);
    for (let i = 1; i < groups.length; i++) {
      expect(idx(groups[i].domain)).toBeGreaterThan(idx(groups[i - 1].domain));
    }
  });

  it("caps each domain independently", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      hit({ domain: "activity", title: `Run ${i}`, key: `a${i}` })
    );
    const groups = rankAndGroup(many, "run", 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].hits).toHaveLength(5);
  });

  it("labels each group", () => {
    const groups = rankAndGroup(
      [hit({ domain: "document", title: "CBC" })],
      ""
    );
    expect(groups[0].label).toBe("Documents");
  });
});

// #19: the clinical passport domains (conditions, allergies, procedures,
// encounters/visits, appointments, family history, care plan, care goals) joined
// the fan-out. They must be first-class in the ranker: labelled, ordered, and
// ranked with the same exact > prefix > substring quality as clinical results so an
// exact clinical name (e.g. "Penicillin") tops its group.
describe("clinical passport domains (#19)", () => {
  const CLINICAL: SearchDomain[] = [
    "condition",
    "allergy",
    "procedure",
    "encounter",
    "appointment",
    "family-history",
    "care-plan",
    "care-goal",
  ];

  it("every domain is ordered and labelled", () => {
    for (const d of CLINICAL) {
      expect(SEARCH_DOMAIN_ORDER).toContain(d);
      expect(SEARCH_DOMAIN_LABELS[d]).toBeTruthy();
    }
  });

  it("ranks an exact clinical name above a substring one (like clinical results)", () => {
    const out = sortHits(
      [
        hit({ domain: "allergy", title: "Penicillin V", key: "a-prefix" }), // prefix (2)
        hit({ domain: "allergy", title: "Penicillin", key: "a-exact" }), // exact (3)
        hit({
          domain: "allergy",
          title: "Amoxicillin (penicillin)",
          key: "a-sub",
        }), // substring (1)
      ],
      "penicillin"
    );
    expect(out.map((h) => h.key)).toEqual(["a-exact", "a-prefix", "a-sub"]);
  });

  it("groups clinical hits into their own domains in canonical order", () => {
    const groups = rankAndGroup(
      [
        hit({ domain: "care-goal", title: "Lower A1c", key: "cg1" }),
        hit({ domain: "allergy", title: "Penicillin", key: "al1" }),
        hit({ domain: "condition", title: "Hypertension", key: "co1" }),
        hit({ domain: "encounter", title: "Office Visit", key: "en1" }),
      ],
      ""
    );
    // Emitted in SEARCH_DOMAIN_ORDER: condition < allergy < encounter < care-goal.
    expect(groups.map((g) => g.domain)).toEqual([
      "condition",
      "allergy",
      "encounter",
      "care-goal",
    ]);
    const idx = (d: string) => SEARCH_DOMAIN_ORDER.indexOf(d as never);
    for (let i = 1; i < groups.length; i++) {
      expect(idx(groups[i].domain)).toBeGreaterThan(idx(groups[i - 1].domain));
    }
  });

  it("labels the family-history group with a human name", () => {
    const groups = rankAndGroup(
      [hit({ domain: "family-history", title: "Diabetes" })],
      ""
    );
    expect(groups[0].label).toBe("Family History");
  });
});

// #1595: the second-generation entity domains (the provider directory, the
// specialty/result record types, illness episodes, protocols, wellness practices,
// equipment) joined the fan-out. Like the #19 set they must be labelled, ordered, and
// ranked identically — and the pre-existing domains must keep their relative order so
// an existing reader's muscle memory survives the insertion.
describe("second-generation entity domains (#1595)", () => {
  const ADDED: SearchDomain[] = [
    "provider",
    "imaging",
    "genomic",
    "episode",
    "dental",
    "skin",
    "protocol",
    "practice",
    "equipment",
  ];

  it("every added domain is ordered and labelled", () => {
    for (const d of ADDED) {
      expect(SEARCH_DOMAIN_ORDER).toContain(d);
      expect(SEARCH_DOMAIN_LABELS[d]).toBeTruthy();
    }
  });

  it("orders every declared domain exactly once", () => {
    const labelled = Object.keys(SEARCH_DOMAIN_LABELS) as SearchDomain[];
    expect([...SEARCH_DOMAIN_ORDER].sort()).toEqual([...labelled].sort());
    expect(new Set(SEARCH_DOMAIN_ORDER).size).toBe(SEARCH_DOMAIN_ORDER.length);
  });

  it("keeps the original domains in their established relative order", () => {
    const original: SearchDomain[] = [
      "clinical-result",
      "document",
      "condition",
      "allergy",
      "procedure",
      "immunization",
      "encounter",
      "appointment",
      "activity",
      "supplement",
      "family-history",
      "care-plan",
      "care-goal",
      "goal",
      "page",
    ];
    expect(SEARCH_DOMAIN_ORDER.filter((d) => original.includes(d))).toEqual(
      original
    );
  });

  it("keeps the results family together, ahead of the record surfaces", () => {
    const idx = (d: SearchDomain) => SEARCH_DOMAIN_ORDER.indexOf(d);
    expect(idx("imaging")).toBe(idx("clinical-result") + 1);
    expect(idx("genomic")).toBe(idx("imaging") + 1);
    // Pages stay last: a jump-to-page entry never outranks a real record.
    expect(idx("page")).toBe(SEARCH_DOMAIN_ORDER.length - 1);
  });

  it("ranks an exact entity name above a substring one (like every other domain)", () => {
    const out = sortHits(
      [
        hit({ domain: "protocol", title: "Sauna block v2", key: "p-prefix" }),
        hit({ domain: "protocol", title: "Sauna block", key: "p-exact" }),
        hit({ domain: "protocol", title: "Winter sauna block", key: "p-sub" }),
      ],
      "sauna block"
    );
    expect(out.map((h) => h.key)).toEqual(["p-exact", "p-prefix", "p-sub"]);
  });

  it("groups added-domain hits into their own domains in canonical order", () => {
    const groups = rankAndGroup(
      [
        hit({ domain: "equipment", title: "Trap bar", key: "eq1" }),
        hit({ domain: "imaging", title: "MRI Left Knee", key: "im1" }),
        hit({ domain: "provider", title: "Northgate Clinic", key: "pr1" }),
        hit({ domain: "skin", title: "Freckled mole", key: "sk1" }),
      ],
      ""
    );
    expect(groups.map((g) => g.domain)).toEqual([
      "imaging",
      "provider",
      "skin",
      "equipment",
    ]);
  });
});

describe("flattenHits", () => {
  it("walks groups top-to-bottom into one nav order", () => {
    const groups = rankAndGroup(
      [
        hit({ domain: "clinical-result", title: "HDL", key: "b1" }),
        hit({ domain: "clinical-result", title: "LDL", key: "b2" }),
        hit({ domain: "supplement", title: "Zinc", key: "s1" }),
      ],
      ""
    );
    expect(flattenHits(groups).map((h) => h.key)).toEqual(["b1", "b2", "s1"]);
  });
});

// #5006: the record's seven row-only Logs kinds are ONE `logged` domain (owner ruling,
// 2026-09-04): capped at five ACROSS all of them, ranked date-first, and sitting above
// the catalog entities that name what the rows were logged against. The kind is in the
// subtitle, so this domain is the only one whose group mixes kinds.
describe("the logged domain (#5006)", () => {
  const idx = (d: SearchDomain) => SEARCH_DOMAIN_ORDER.indexOf(d);

  it("is labelled, and ordered above the catalog entities and the page entries", () => {
    expect(SEARCH_DOMAIN_LABELS.logged).toBe("Logged");
    for (const below of [
      "supplement",
      "protocol",
      "practice",
      "equipment",
      "page",
    ] as const) {
      expect(idx("logged")).toBeLessThan(idx(below));
    }
  });

  it("sorts the logged group by date first, an entity group by match quality first", () => {
    const cases = [
      ["logged", ["newer-sub", "older-exact"]],
      ["practice", ["older-exact", "newer-sub"]],
    ] as const;
    for (const [domain, order] of cases) {
      const out = sortHits(
        [
          hit({
            domain,
            title: "Sauna",
            key: "older-exact",
            date: "2026-01-02",
          }),
          hit({
            domain,
            title: "Sauna, infrared",
            key: "newer-sub",
            date: "2026-08-29",
          }),
        ],
        "sauna"
      );
      expect(out.map((h) => h.key)).toEqual(order);
    }
  });

  it("still breaks a same-day tie by match quality", () => {
    const out = sortHits(
      [
        hit({
          domain: "logged",
          title: "Berries and cream",
          key: "sub",
          date: "2026-08-29",
        }),
        hit({
          domain: "logged",
          title: "Berries",
          key: "exact",
          date: "2026-08-29",
        }),
      ],
      "berries"
    );
    expect(out.map((h) => h.key)).toEqual(["exact", "sub"]);
  });

  // THE CAP IS FIVE ACROSS ALL KINDS, RANKED BEFORE IT IS APPLIED. The fixture is
  // built so the three candidate implementations disagree: three kinds each hold SIX
  // matching rows, and the union's newest five are three practices and two doses.
  // Five-per-kind would return fifteen; a round-robin would reach the symptom (whose
  // newest row is sixth overall) and drop the third practice.
  it("keeps the newest five of the union, not five of each kind", () => {
    const logged = [
      ["practice", ["08-31", "08-30", "08-29", "08-20", "08-19", "08-18"]],
      ["dose", ["08-28", "08-27", "08-17", "08-16", "08-15", "08-14"]],
      ["symptom", ["08-26", "08-25", "08-24", "08-23", "08-22", "08-21"]],
    ] as const;
    const hits = logged.flatMap(([kind, days]) =>
      days.map((day) =>
        hit({
          domain: "logged",
          title: "Birch sauna",
          key: `${kind}:${day}`,
          date: `2026-${day}`,
        })
      )
    );
    const groups = rankAndGroup(hits, "birch");
    expect(groups).toHaveLength(1);
    expect(groups[0].hits.map((h) => h.key)).toEqual([
      "practice:08-31",
      "practice:08-30",
      "practice:08-29",
      "dose:08-28",
      "dose:08-27",
    ]);
  });
});
