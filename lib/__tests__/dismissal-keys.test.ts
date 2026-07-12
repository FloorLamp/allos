import { describe, it, expect } from "vitest";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
  immunizationDismissalKey,
  immunizationCodesLosingBacking,
} from "../dismissal-keys";

describe("biomarkerDismissalKey", () => {
  it("keys a non-family analyte on its own lowercased/trimmed name", () => {
    expect(biomarkerDismissalKey("Glucose")).toBe("biomarker:glucose");
    expect(biomarkerDismissalKey("  LDL Cholesterol  ")).toBe(
      "biomarker:ldl cholesterol"
    );
  });

  it("keys a family member on its #482 family so any member's dismiss covers it", () => {
    // The 25-OH vitamin-D variants collapse to one family key — a dismiss on the
    // total silences the whole family's retest nudge and the key doesn't drift as
    // which member is the newest reading changes.
    expect(biomarkerDismissalKey("  Vitamin D, 25-Hydroxy  ")).toBe(
      "biomarker:family:vitamin-d-25-hydroxy"
    );
    expect(biomarkerDismissalKey("Vitamin D3, 25-Hydroxy")).toBe(
      biomarkerDismissalKey("Vitamin D, Total")
    );
    // A1c ↔ eAG likewise share one retest key.
    expect(biomarkerDismissalKey("HbA1c")).toBe(
      biomarkerDismissalKey("Estimated Average Glucose")
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

describe("biomarker key prefixes stay in lock-step with the orphan sweep offsets", () => {
  // cleanupOrphanBiomarkerDismissals (lib/queries/upcoming.ts) compares
  // `substr(signal_key, 11)` against the record names for the retest keys and
  // `substr(signal_key, 16)` for the flag keys — where 11 = len('biomarker:') + 1
  // and 16 = len('biomarker-flag:') + 1. If either prefix is ever renamed without
  // updating those SQL offsets, the sweep would slice the name mid-string and
  // stop matching (silently keeping every orphan). Lock the prefix lengths here so
  // that coupling can't drift unnoticed.
  it("retest prefix is 'biomarker:' (len 10 → substr offset 11)", () => {
    const key = biomarkerDismissalKey("Glucose");
    expect(key.indexOf(":")).toBe(9); // 0-based colon → prefix length 10
    expect("biomarker:".length + 1).toBe(11);
    expect(key.slice(10)).toBe("glucose"); // substr(_, 11) in SQLite (1-based)
  });

  it("flag prefix is 'biomarker-flag:' (len 15 → substr offset 16)", () => {
    const key = biomarkerFlagDismissalKey("Glucose");
    expect("biomarker-flag:".length + 1).toBe(16);
    expect(key.slice(15)).toBe("glucose"); // substr(_, 16) in SQLite (1-based)
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
