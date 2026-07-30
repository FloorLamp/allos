import { describe, it, expect } from "vitest";
import {
  CONFIDENCE_KINDS,
  confidenceKindLabel,
  confidenceLabel,
  confidenceRank,
  confidenceTotal,
  mergeConfidenceSummaries,
  needsScrutiny,
  normalizeConfidence,
  normalizeConfidenceReason,
  parseConfidenceSummary,
  rankByConfidence,
  summarizeExtractionConfidence,
  type ConfidenceItem,
} from "../extraction-confidence";
import type { DropKind } from "../import-report";

// Per-record extraction confidence (#1601): the ONE pure model that decides which
// extracted rows a human should look at first. Everything here is contract, not
// styling — the import-detail card, the Review feed badge, and the persisted report
// summary all read these functions.

function item(
  label: string,
  confidence: ConfidenceItem["confidence"],
  reason: string | null = null,
  kind: ConfidenceItem["kind"] = "lab"
): ConfidenceItem {
  return { kind, label, confidence, reason };
}

describe("normalizeConfidence", () => {
  it("accepts the vocabulary case- and whitespace-insensitively", () => {
    expect(normalizeConfidence("high")).toBe("high");
    expect(normalizeConfidence(" HIGH ")).toBe("high");
    expect(normalizeConfidence("Medium")).toBe("medium");
    expect(normalizeConfidence("low")).toBe("low");
  });

  it("accepts the near-miss words a model reaches for", () => {
    expect(normalizeConfidence("certain")).toBe("high");
    expect(normalizeConfidence("moderate")).toBe("medium");
    expect(normalizeConfidence("med")).toBe("medium");
    expect(normalizeConfidence("uncertain")).toBe("low");
  });

  it("treats anything else as UNKNOWN rather than guessing a tier", () => {
    // A number, an invented word, a blank, and an absent field are all "nobody
    // said" — never a synthetic 'low' that would jump a legacy row to the top of
    // the review queue.
    expect(normalizeConfidence(0.9)).toBeNull();
    expect(normalizeConfidence("very sure")).toBeNull();
    expect(normalizeConfidence("")).toBeNull();
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence(undefined)).toBeNull();
    expect(normalizeConfidence({ confidence: "low" })).toBeNull();
  });
});

describe("normalizeConfidenceReason", () => {
  it("keeps a short why for a hedged row", () => {
    expect(normalizeConfidenceReason("  unit smudged  ", "low")).toBe(
      "unit smudged"
    );
    expect(normalizeConfidenceReason("date inferred", "medium")).toBe(
      "date inferred"
    );
  });

  it("drops a reason attached to a high or unknown row", () => {
    // "Looks fine" on a high row is noise, and a reason with no tier has nothing to
    // explain.
    expect(normalizeConfidenceReason("looks fine", "high")).toBeNull();
    expect(normalizeConfidenceReason("looks fine", null)).toBeNull();
  });

  it("truncates a runaway reason instead of dropping the hint", () => {
    const long = "unit unclear ".repeat(40);
    const kept = normalizeConfidenceReason(long, "low")!;
    expect(kept.length).toBe(140);
    expect(kept.startsWith("unit unclear")).toBe(true);
  });
});

describe("ranking", () => {
  it("orders low → medium → high → unknown", () => {
    expect(
      [null, "high", "low", "medium"]
        .map((c) => confidenceRank(c as never))
        .slice()
    ).toEqual([3, 2, 0, 1]);
  });

  it("puts the hedged rows first and unknown last, stably within a tier", () => {
    const ranked = rankByConfidence([
      item("Sure One", "high"),
      item("Legacy One", null),
      item("Hedge A", "medium"),
      item("Doubt A", "low"),
      item("Hedge B", "medium"),
      item("Doubt B", "low"),
      item("Legacy Two", null),
    ]);
    expect(ranked.map((r) => r.label)).toEqual([
      "Doubt A",
      "Doubt B",
      "Hedge A",
      "Hedge B",
      "Sure One",
      "Legacy One",
      "Legacy Two",
    ]);
  });

  it("marks only the tiers the model hedged on as needing scrutiny", () => {
    expect(needsScrutiny("low")).toBe(true);
    expect(needsScrutiny("medium")).toBe(true);
    expect(needsScrutiny("high")).toBe(false);
    // A legacy row is not evidence of doubt — it must not inflate the badge.
    expect(needsScrutiny(null)).toBe(false);
  });
});

describe("summarizeExtractionConfidence", () => {
  it("counts every tier and flags the hedged rows lowest-first", () => {
    const summary = summarizeExtractionConfidence([
      item("Ferritin", "high"),
      item("Sodium", "medium", "unit ambiguous"),
      item("Collected", "low", "date smudged on scan"),
      item("Asthma", "medium", null, "condition"),
      item("Unstated", null),
    ])!;
    expect(summary.counts).toEqual({
      high: 1,
      medium: 2,
      low: 1,
      unknown: 1,
    });
    expect(summary.scrutiny).toBe(3);
    expect(summary.flags.map((f) => f.label)).toEqual([
      "Collected",
      "Sodium",
      "Asthma",
    ]);
    expect(summary.flags[0]).toEqual({
      kind: "lab",
      label: "Collected",
      confidence: "low",
      reason: "date smudged on scan",
    });
    // The flagged total is the denominator's complement, not a separate count.
    expect(confidenceTotal(summary)).toBe(5);
  });

  it("returns null when NO row carried a confidence at all", () => {
    // A deterministic CCD/FHIR import, a keyless extraction, and a replay of a
    // pre-#1601 stored extraction all land here: "nobody asked" must stay
    // distinguishable from "the model was sure", so the surfaces render nothing
    // rather than a wall of zeros.
    expect(
      summarizeExtractionConfidence([item("A", null), item("B", null)])
    ).toBeNull();
    expect(summarizeExtractionConfidence([])).toBeNull();
    expect(confidenceTotal(null)).toBe(0);
  });

  it("summarizes a document the model was sure about throughout", () => {
    const summary = summarizeExtractionConfidence([
      item("A", "high"),
      item("B", "high"),
    ])!;
    expect(summary.scrutiny).toBe(0);
    expect(summary.flags).toEqual([]);
    // A signal with nothing to check is still a signal — the card just stays away.
    expect(confidenceTotal(summary)).toBe(2);
  });
});

describe("mergeConfidenceSummaries", () => {
  it("adds counts and re-ranks the concatenated flags", () => {
    const a = summarizeExtractionConfidence([
      item("Doc1 Medium", "medium"),
      item("Doc1 High", "high"),
    ])!;
    const b = summarizeExtractionConfidence([
      item("Doc2 Low", "low"),
      item("Doc2 Unstated", null),
    ])!;
    const merged = mergeConfidenceSummaries([a, null, b])!;
    expect(merged.counts).toEqual({
      high: 1,
      medium: 1,
      low: 1,
      unknown: 1,
    });
    // Neither document's hedged rows are lost, and the merged list still reads
    // lowest-first across documents.
    expect(merged.flags.map((f) => f.label)).toEqual([
      "Doc2 Low",
      "Doc1 Medium",
    ]);
    expect(merged.scrutiny).toBe(2);
  });

  it("is null when no document carried a signal", () => {
    expect(mergeConfidenceSummaries([null, undefined])).toBeNull();
    expect(mergeConfidenceSummaries([])).toBeNull();
  });
});

describe("parseConfidenceSummary", () => {
  it("round-trips a written summary", () => {
    const summary = summarizeExtractionConfidence([
      item("Ferritin", "low", "value unclear"),
      item("Asthma", "medium", null, "condition"),
      item("Sodium", "high"),
    ])!;
    expect(parseConfidenceSummary(JSON.parse(JSON.stringify(summary)))).toEqual(
      summary
    );
  });

  it("degrades an unusable blob to no signal", () => {
    expect(parseConfidenceSummary(null)).toBeNull();
    expect(parseConfidenceSummary("low")).toBeNull();
    expect(parseConfidenceSummary([])).toBeNull();
    expect(parseConfidenceSummary({})).toBeNull();
    expect(parseConfidenceSummary({ flags: [] })).toBeNull();
    expect(parseConfidenceSummary({ counts: { high: "many" } })).toBeNull();
  });

  it("re-derives scrutiny rather than trusting a stored total", () => {
    const parsed = parseConfidenceSummary({
      counts: { high: 1, medium: 1, low: 0, unknown: 0 },
      scrutiny: 42,
      flags: [{ kind: "lab", label: "Sodium", confidence: "medium" }],
    })!;
    expect(parsed.scrutiny).toBe(1);
  });
});

describe("labels", () => {
  it("names every tier, including an absent one", () => {
    expect(confidenceLabel("low")).toBe("low confidence");
    expect(confidenceLabel("medium")).toBe("medium confidence");
    expect(confidenceLabel("high")).toBe("high confidence");
    expect(confidenceLabel(null)).toBe("confidence not reported");
  });

  it("labels every extracted domain", () => {
    for (const kind of CONFIDENCE_KINDS) {
      expect(confidenceKindLabel(kind)).toBeTruthy();
      expect(confidenceKindLabel(kind)).not.toBe(kind);
    }
  });

  it("keeps its kind vocabulary a subset of the report's DropKind", () => {
    // The confidence module is a leaf (import-report depends on IT), so the two
    // lists are declared separately — this pins them in sync so a flagged row's
    // kind always means the same thing as a dropped row's kind.
    const kinds: DropKind[] = [...CONFIDENCE_KINDS];
    expect(kinds).toHaveLength(CONFIDENCE_KINDS.length);
  });
});
