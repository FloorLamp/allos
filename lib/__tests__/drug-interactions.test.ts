import { describe, expect, it } from "vitest";
import {
  detectInteractions,
  interactionsForCandidate,
  matchConceptKeys,
  interactionSignalKey,
  interactionTitle,
  interactionDetail,
  SEVERITY_RANK,
  type InteractionItem,
} from "@/lib/drug-interactions";

// Pure drug-/supplement-interaction detection (issue #144). Synthetic item pairs
// only — no real PHI. Exercises: a hit, a no-hit, a supplement-drug hit, rxcui-keyed
// vs name-fallback matching, inactive/paused exclusion, severity ranking, and the
// id-pair dedupeKey.

function item(
  id: number,
  name: string,
  opts: { rxcui?: string | null; active?: boolean } = {}
): InteractionItem {
  return {
    id,
    name,
    rxcui: opts.rxcui ?? null,
    active: opts.active ?? true,
  };
}

describe("matchConceptKeys", () => {
  it("matches an NSAID by name (fallback) even with no rxcui", () => {
    expect(
      matchConceptKeys({ name: "Ibuprofen 200mg", rxcui: null })
    ).toContain("nsaid");
  });

  it("matches warfarin by its RxCUI even when the name is unhelpful", () => {
    // A gibberish name that no synonym matches — the code carries the identity.
    expect(
      matchConceptKeys({ name: "Generic tablet A", rxcui: "11289" })
    ).toContain("warfarin");
  });

  it("does word-boundary matching, not naive substring", () => {
    // "iron" must not match inside "environmental".
    expect(
      matchConceptKeys({ name: "Environmental greens blend", rxcui: null })
    ).not.toContain("iron");
    expect(
      matchConceptKeys({ name: "Iron bisglycinate", rxcui: null })
    ).toContain("iron");
  });

  it("matches a multi-word supplement synonym (St. John's Wort)", () => {
    expect(
      matchConceptKeys({ name: "St. John's Wort 300 mg", rxcui: null })
    ).toContain("st_johns_wort");
  });
});

describe("detectInteractions", () => {
  it("flags warfarin + ibuprofen as a major interaction", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
    expect(hits[0].aId).toBe(1);
    expect(hits[0].bId).toBe(2);
    expect(hits[0].dedupeKey).toBe("interaction:1-2");
    expect(hits[0].mechanism.length).toBeGreaterThan(0);
    expect(hits[0].source.length).toBeGreaterThan(0);
  });

  it("returns no hit for a non-interacting pair", () => {
    const hits = detectInteractions([
      item(1, "Vitamin D3"),
      item(2, "Creatine Monohydrate"),
    ]);
    expect(hits).toHaveLength(0);
  });

  it("detects a supplement-drug interaction (St. John's Wort + an SSRI)", () => {
    const hits = detectInteractions([
      item(1, "Sertraline"),
      item(2, "St. John's Wort"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("matches by name-fallback when no rxcui is set", () => {
    // Neither item carries a code — both resolve by name (warfarin, nsaid).
    const hits = detectInteractions([item(1, "Warfarin"), item(2, "Naproxen")]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("excludes inactive/paused items from detection", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen", { active: false }),
    ]);
    expect(hits).toHaveLength(0);
  });

  it("dedupes to one hit per item pair, keeping the most severe rule", () => {
    // Levothyroxine + calcium is one pair; only one finding, and calcium+iron
    // adds a separate pair.
    const hits = detectInteractions([
      item(1, "Levothyroxine"),
      item(2, "Calcium carbonate"),
      item(3, "Ferrous sulfate"),
    ]);
    // levo+calcium, levo+iron, calcium+iron → 3 distinct pairs.
    const keys = hits.map((h) => h.dedupeKey).sort();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("interaction:1-2");
    expect(keys).toContain("interaction:1-3");
    expect(keys).toContain("interaction:2-3");
  });

  it("ranks major before moderate before minor", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"), // major with warfarin
      item(3, "Fish oil"), // moderate with warfarin
    ]);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // First hit is the most severe.
    for (let i = 1; i < hits.length; i++) {
      expect(SEVERITY_RANK[hits[i - 1].severity]).toBeLessThanOrEqual(
        SEVERITY_RANK[hits[i].severity]
      );
    }
  });

  it("does not pair an item with itself", () => {
    const hits = detectInteractions([item(1, "Ibuprofen")]);
    expect(hits).toHaveLength(0);
  });
});

describe("interactionsForCandidate", () => {
  const stack: InteractionItem[] = [
    item(1, "Warfarin", { rxcui: "11289" }),
    item(2, "Vitamin D3"),
  ];

  it("flags a new item that interacts with the existing stack", () => {
    const hits = interactionsForCandidate(
      { name: "Ibuprofen", rxcui: null },
      stack
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("returns nothing for a new item that doesn't interact", () => {
    const hits = interactionsForCandidate(
      { name: "Magnesium glycinate", rxcui: null },
      stack
    );
    expect(hits).toHaveLength(0);
  });

  it("does not pair the candidate with the row it is editing (same id excluded upstream)", () => {
    // The candidate is id 0; a stack that includes a stale copy at id 0 is filtered.
    const hits = interactionsForCandidate(
      { name: "Warfarin", rxcui: "11289" },
      [item(0, "Warfarin", { rxcui: "11289" }), item(2, "Vitamin D3")]
    );
    expect(hits).toHaveLength(0);
  });
});

describe("formatting + keys", () => {
  it("interactionSignalKey is direction-independent", () => {
    expect(interactionSignalKey(5, 2)).toBe("interaction:2-5");
    expect(interactionSignalKey(2, 5)).toBe("interaction:2-5");
  });

  it("interactionTitle joins the two names", () => {
    const hit = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ])[0];
    expect(interactionTitle(hit)).toBe("Warfarin + Ibuprofen");
  });

  it("interactionDetail is informational, never prescriptive", () => {
    const hit = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ])[0];
    const detail = interactionDetail(hit);
    expect(detail).toContain("discuss with your prescriber");
    expect(detail.toLowerCase()).not.toContain("stop taking");
  });
});
