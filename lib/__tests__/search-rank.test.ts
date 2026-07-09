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
    domain: "biomarker",
    key: `k:${over.title}`,
    subtitle: null,
    href: "/x",
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
        hit({ domain: "biomarker", title: "HDL", key: "b1" }),
        hit({ domain: "page", title: "Settings", key: "p1" }),
      ],
      ""
    );
    expect(groups.map((g) => g.domain)).toEqual(["biomarker", "goal", "page"]);
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
// ranked with the same exact > prefix > substring quality as biomarkers so an
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

  it("ranks an exact clinical name above a substring one (like biomarkers)", () => {
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

describe("flattenHits", () => {
  it("walks groups top-to-bottom into one nav order", () => {
    const groups = rankAndGroup(
      [
        hit({ domain: "biomarker", title: "HDL", key: "b1" }),
        hit({ domain: "biomarker", title: "LDL", key: "b2" }),
        hit({ domain: "supplement", title: "Zinc", key: "s1" }),
      ],
      ""
    );
    expect(flattenHits(groups).map((h) => h.key)).toEqual(["b1", "b2", "s1"]);
  });
});
