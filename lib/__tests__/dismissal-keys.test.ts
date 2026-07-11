import { describe, it, expect } from "vitest";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
  immunizationDismissalKey,
  immunizationCodesLosingBacking,
} from "../dismissal-keys";

describe("biomarkerDismissalKey", () => {
  it("lowercases and trims to match the retest nudge key", () => {
    expect(biomarkerDismissalKey("Glucose")).toBe("biomarker:glucose");
    expect(biomarkerDismissalKey("  Vitamin D, 25-Hydroxy  ")).toBe(
      "biomarker:vitamin d, 25-hydroxy"
    );
  });
});

describe("biomarkerFlagDismissalKey", () => {
  it("lowercases and trims to match the hero's flagged-result key (issue #283)", () => {
    expect(biomarkerFlagDismissalKey("LDL Cholesterol")).toBe(
      "biomarker-flag:ldl cholesterol"
    );
    expect(biomarkerFlagDismissalKey("  Glucose ")).toBe(
      "biomarker-flag:glucose"
    );
  });

  it("never collides with the retest key namespace", () => {
    expect(biomarkerFlagDismissalKey("x")).not.toBe(biomarkerDismissalKey("x"));
    // The orphan sweep matches the retest keys with LIKE 'biomarker:%' — the
    // flag prefix must not fall inside that pattern.
    expect(biomarkerFlagDismissalKey("x").startsWith("biomarker:")).toBe(false);
  });
});

describe("immunizationDismissalKey", () => {
  it("prefixes the raw catalog code", () => {
    expect(immunizationDismissalKey("mmr")).toBe("immunization:mmr");
  });
});

describe("immunizationCodesLosingBacking", () => {
  it("reports a plain code when no remaining dose still credits it", () => {
    expect(immunizationCodesLosingBacking("mmr", [])).toEqual(["mmr"]);
    expect(immunizationCodesLosingBacking("mmr", ["hepb"])).toEqual(["mmr"]);
  });

  it("reports nothing when a sibling dose still credits the code", () => {
    expect(immunizationCodesLosingBacking("mmr", ["mmr"])).toEqual([]);
  });

  it("keeps combo components still covered by a remaining dose", () => {
    // A combo credits several component codes; deleting it only un-backs the
    // components no remaining dose still covers.
    const lost = immunizationCodesLosingBacking("proquad", ["mmr"]);
    // proquad = mmr + varicella; mmr is still backed by the standalone dose.
    expect(lost).toContain("varicella");
    expect(lost).not.toContain("mmr");
  });

  it("un-backs every combo component when nothing remains", () => {
    const lost = immunizationCodesLosingBacking("proquad", []);
    expect(lost).toEqual(expect.arrayContaining(["mmr", "varicella"]));
  });

  it("ignores an unknown slug (it credits no series)", () => {
    expect(immunizationCodesLosingBacking("made_up_shot", [])).toEqual([]);
  });
});
