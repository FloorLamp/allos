import { describe, expect, it } from "vitest";
import {
  BIOMARKER_GROUP_LABELS,
  BIOMARKER_PICKER_GROUPS,
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

describe("biomarker picker rank signal boundaries (#1675)", () => {
  it("ranks a retest-due marker above a flagged one, and both above due-soon", () => {
    const names = ["Ferritin", "Hemoglobin A1c", "LDL Cholesterol"];
    const facts = emptyBiomarkerRankFacts();
    facts.dueSoon = new Set([biomarkerRankKey("Ferritin")]);
    facts.flagged = new Set([biomarkerRankKey("LDL Cholesterol")]);
    facts.due = new Set([biomarkerRankKey("Hemoglobin A1c")]);

    expect(rankBiomarkers(names, facts).map((item) => item.name)).toEqual([
      "Hemoglobin A1c",
      "LDL Cholesterol",
      "Ferritin",
    ]);
  });

  it("puts a starred marker ahead of a merely measured one, and a PhenoAge input ahead of an untouched marker", () => {
    // All four sit in the SAME group boundary case only for the first pair:
    // starred/measured are "your markers", a pillar input on its own is not — the
    // pillar signal orders within the tail rather than promoting out of it.
    const facts = emptyBiomarkerRankFacts();
    facts.starred = new Set([biomarkerRankKey("Ferritin")]);
    facts.measured = new Set([biomarkerRankKey("Albumin")]);
    const yours = rankBiomarkers(["Albumin", "Ferritin"], facts);
    expect(yours.map((item) => item.name)).toEqual(["Ferritin", "Albumin"]);
    expect(yours.every((item) => item.group === "your-markers")).toBe(true);

    const pillarFacts = emptyBiomarkerRankFacts();
    pillarFacts.pillar = new Set([biomarkerRankKey("Zzz Fictionase")]);
    const tail = rankBiomarkers(
      ["Aaa Fictionase", "Zzz Fictionase"],
      pillarFacts
    );
    expect(tail.map((item) => item.name)).toEqual([
      "Zzz Fictionase",
      "Aaa Fictionase",
    ]);
    expect(tail.every((item) => item.group === "all-biomarkers")).toBe(true);
  });

  it("breaks ties deterministically on the base layout, not on input order", () => {
    // Two uncurated names with identical signals: alphabetical either way round.
    const facts = emptyBiomarkerRankFacts();
    facts.measured = new Set([
      biomarkerRankKey("Mmm Fictionase"),
      biomarkerRankKey("Bbb Fictionase"),
    ]);
    const forward = rankBiomarkers(["Mmm Fictionase", "Bbb Fictionase"], facts);
    const reverse = rankBiomarkers(["Bbb Fictionase", "Mmm Fictionase"], facts);
    expect(forward.map((i) => i.name)).toEqual(reverse.map((i) => i.name));
    expect(forward.map((i) => i.name)).toEqual([
      "Bbb Fictionase",
      "Mmm Fictionase",
    ]);
  });

  it("collapses case and duplicate spellings onto one row, keeping the first display form", () => {
    const facts = emptyBiomarkerRankFacts();
    const ranked = rankBiomarkers(
      ["Ferritin", "ferritin", "FERRITIN"],
      facts
    ).map((item) => item.name);
    expect(ranked).toEqual(["Ferritin"]);
  });

  it("names every group it can emit", () => {
    for (const group of BIOMARKER_PICKER_GROUPS) {
      expect(BIOMARKER_GROUP_LABELS[group]).toBeTruthy();
    }
    expect(BIOMARKER_PICKER_GROUPS).toEqual([
      "due-relevant",
      "your-markers",
      "all-biomarkers",
    ]);
  });
});
