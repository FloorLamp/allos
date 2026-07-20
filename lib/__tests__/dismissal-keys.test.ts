import { describe, it, expect } from "vitest";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
  immunizationDismissalKey,
  immunizationCodesLosingBacking,
  preventiveDismissalKey,
} from "../dismissal-keys";

describe("preventiveDismissalKey (issue #1024)", () => {
  it("reproduces the item/nudge `<kind>:<ruleKey>` signal by resolving the rule kind", () => {
    // A screening rule keys under `screening:<ruleKey>`; a visit rule under
    // `visit:<ruleKey>` — the exact string a dismiss was stored under, so the
    // episode-end sweep can retire it.
    expect(preventiveDismissalKey("colorectal_cancer")).toBe(
      "screening:colorectal_cancer"
    );
    expect(preventiveDismissalKey("adult_physical")).toBe(
      "visit:adult_physical"
    );
  });

  it("returns null for an unknown rule key (nothing to retire)", () => {
    expect(preventiveDismissalKey("not_a_real_rule")).toBeNull();
  });
});

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
  it("keys a non-family analyte on its own lowercased/trimmed name (issue #283)", () => {
    expect(biomarkerFlagDismissalKey("LDL Cholesterol")).toBe(
      "biomarker-flag:ldl cholesterol"
    );
    expect(biomarkerFlagDismissalKey("  Glucose ")).toBe(
      "biomarker-flag:glucose"
    );
  });

  it("keys a family member on its #482 family, matching the retest key's family portion (issue #564)", () => {
    // The flag key now uses biomarkerFamily (was raw name — the false-parity #482
    // gap), so a dismiss on "Vitamin D3" covers "Vitamin D2 / Total 25-OH".
    expect(biomarkerFlagDismissalKey("Vitamin D3")).toBe(
      "biomarker-flag:family:vitamin-d-25-hydroxy"
    );
    expect(biomarkerFlagDismissalKey("Vitamin D3, 25-Hydroxy")).toBe(
      biomarkerFlagDismissalKey("Vitamin D, Total")
    );
    // The flag key and the retest key resolve to the SAME family portion — the
    // shared acknowledgment (#564) lines up with the retest key that only differs
    // by prefix ("biomarker-flag:" vs "biomarker:").
    expect(
      biomarkerFlagDismissalKey("HbA1c").slice("biomarker-flag:".length)
    ).toBe(
      biomarkerDismissalKey("Estimated Average Glucose").slice(
        "biomarker:".length
      )
    );
  });

  it("never collides with the retest key namespace", () => {
    expect(biomarkerFlagDismissalKey("x")).not.toBe(biomarkerDismissalKey("x"));
    // The orphan sweep matches the retest keys with LIKE 'biomarker:%' — the
    // flag prefix must not fall inside that pattern.
    expect(biomarkerFlagDismissalKey("x").startsWith("biomarker:")).toBe(false);
    // Even a family member (whose suffix is "family:…") stays under the flag prefix.
    expect(
      biomarkerFlagDismissalKey("Vitamin D3").startsWith("biomarker:")
    ).toBe(false);
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
