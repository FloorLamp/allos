import { describe, expect, it } from "vitest";
import {
  biomarkerRankKey,
  emptyBiomarkerRankFacts,
  rankBiomarkers,
} from "@/lib/biomarker-rank";
import { CURATED_LABS } from "@/lib/curated-biomarkers";

describe("biomarker picker rank (#1675)", () => {
  it("preserves curated order, then alphabetizes the uncurated tail with no signals", () => {
    const earlier = CURATED_LABS[2].name;
    const later = CURATED_LABS[10].name;
    const ranked = rankBiomarkers(
      ["Zeta Fictionase", later, "Alpha Fictionase", earlier],
      emptyBiomarkerRankFacts()
    );

    expect(ranked.map((item) => item.name)).toEqual([
      earlier,
      later,
      "Alpha Fictionase",
      "Zeta Fictionase",
    ]);
    expect(ranked.every((item) => item.group === "all-biomarkers")).toBe(true);
  });

  it("groups due and flagged markers first, then measured/starred markers", () => {
    const names = [
      "Albumin",
      "Hemoglobin A1c",
      "LDL Cholesterol",
      "Rubella IgG",
    ];
    const facts = emptyBiomarkerRankFacts();
    facts.due = new Set([biomarkerRankKey("Hemoglobin A1c")]);
    facts.flagged = new Set([biomarkerRankKey("LDL Cholesterol")]);
    facts.measured = new Set([biomarkerRankKey("Albumin")]);

    const ranked = rankBiomarkers(names, facts);

    expect(ranked.map((item) => item.group)).toEqual([
      "due-relevant",
      "due-relevant",
      "your-markers",
      "all-biomarkers",
    ]);
    expect(ranked.slice(0, 2).map((item) => item.name)).toEqual([
      "Hemoglobin A1c",
      "LDL Cholesterol",
    ]);
  });

  it("uses bucketed presence rather than dates or raw values", () => {
    const facts = emptyBiomarkerRankFacts();
    facts.dueSoon = new Set([biomarkerRankKey("Albumin")]);
    facts.starred = new Set([biomarkerRankKey("LDL Cholesterol")]);

    expect(
      rankBiomarkers(["LDL Cholesterol", "Albumin"], facts).map((item) => [
        item.name,
        item.group,
      ])
    ).toEqual([
      ["Albumin", "due-relevant"],
      ["LDL Cholesterol", "your-markers"],
    ]);
  });
});
