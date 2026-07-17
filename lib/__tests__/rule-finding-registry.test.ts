import { describe, it, expect } from "vitest";
import {
  RULE_FINDING_REGISTRY,
  RULE_FINDING_PREFIXES,
  findingRegistryEntryFor,
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
  declaredReasonCodesFor,
} from "@/lib/rule-finding-prefixes";
import { REASON_CODES } from "@/lib/reasons";

// Pure structural invariants for the ONE finding-producing builder registry (#860
// Track A, extending #448). The end-to-end tier/reason binding — that the code's actual
// tier matches the declared one — lives in the DB reflection guards
// (rule-findings-builders.test.ts + finding-registry-tiers.test.ts); this pins the shape
// the guards rely on. No DB, no network.

describe("rule-finding registry — structural invariants", () => {
  it("every entry is well-formed (prefix, valid tier, builder, declared reasons)", () => {
    expect(RULE_FINDING_REGISTRY.length).toBeGreaterThan(0);
    for (const e of RULE_FINDING_REGISTRY) {
      expect(e.prefix, "prefix must be non-empty").toBeTruthy();
      expect(["care", "coaching"]).toContain(e.tier);
      expect(e.builder, `${e.prefix}: builder name`).toBeTruthy();
      // Every declared reason code is a real, enumerable ReasonCode (#656) — so the
      // reason-source column can't drift from the closed union.
      for (const code of e.reasons) {
        expect(
          REASON_CODES as readonly string[],
          `${e.prefix}: undeclared reason code ${code}`
        ).toContain(code);
      }
    }
  });

  it("prefixes are unique and non-overlapping (unambiguous resolution)", () => {
    const prefixes = RULE_FINDING_REGISTRY.map((e) => e.prefix);
    // Unique.
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // No prefix is itself a prefix of another — otherwise findingRegistryEntryFor
    // could resolve a key to the wrong (shorter-prefix) entry and mis-tier it.
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(
          a.startsWith(b),
          `prefix "${b}" is a prefix of "${a}" — ambiguous resolution`
        ).toBe(false);
      }
    }
  });

  it("both reach tiers are populated (the #449 partition is real)", () => {
    const tiers = new Set(RULE_FINDING_REGISTRY.map((e) => e.tier));
    expect(tiers.has("coaching")).toBe(true);
    expect(tiers.has("care")).toBe(true);
  });

  it("RULE_FINDING_PREFIXES is exactly the registry's prefixes (backward-compat derive)", () => {
    expect([...RULE_FINDING_PREFIXES].sort()).toEqual(
      RULE_FINDING_REGISTRY.map((e) => e.prefix).sort()
    );
  });

  it("the lookups resolve a known key and refuse an unknown one", () => {
    const entry = RULE_FINDING_REGISTRY[0];
    const key = `${entry.prefix}whatever:123`;
    expect(findingRegistryEntryFor(key)).toBe(entry);
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
    expect(tierForDedupeKey(key)).toBe(entry.tier);
    expect(declaredReasonCodesFor(key)).toEqual(entry.reasons);

    const unknown = "no-such-namespace:xyz";
    expect(findingRegistryEntryFor(unknown)).toBeNull();
    expect(dedupeKeyHasKnownPrefix(unknown)).toBe(false);
    expect(tierForDedupeKey(unknown)).toBeNull();
    expect(declaredReasonCodesFor(unknown)).toBeNull();
  });
});
