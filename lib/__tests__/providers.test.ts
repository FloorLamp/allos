import { describe, it, expect } from "vitest";
import {
  normalizeProviderName,
  normalizeNpi,
  providerDedupKey,
  isUsableProvider,
  cleanProviderInput,
  dedupeProviders,
} from "../providers";

describe("normalizeProviderName", () => {
  it("collapses whitespace and lowercases, keeping punctuation", () => {
    expect(normalizeProviderName("  QUEST   (BEAKER) ")).toBe("quest (beaker)");
    expect(normalizeProviderName("EXAMPLE MEDICAL CARE, PC")).toBe(
      "example medical care, pc"
    );
  });
});

describe("normalizeNpi", () => {
  it("keeps only digits", () => {
    expect(normalizeNpi(" 1000000002 ")).toBe("1000000002");
    expect(normalizeNpi("NPI: 1000-000-002")).toBe("1000000002");
    expect(normalizeNpi(null)).toBe("");
  });
});

describe("providerDedupKey", () => {
  it("keys on NPI when present, regardless of name spelling", () => {
    const a = providerDedupKey({
      name: "Rosalind Franklin",
      type: "individual",
      npi: "1000000002",
    });
    const b = providerDedupKey({
      name: "Dr. R. Franklin",
      type: "individual",
      npi: " 1000000002 ",
    });
    expect(a).toBe("npi:1000000002");
    expect(a).toBe(b); // same NPI → same provider
  });

  it("falls back to identifier, then to normalized name + type", () => {
    expect(
      providerDedupKey({
        name: "Lab X",
        type: "organization",
        identifier: "CLIA9",
      })
    ).toBe("id:clia9");
    expect(
      providerDedupKey({ name: "QUEST (BEAKER)", type: "organization" })
    ).toBe("name:organization:quest (beaker)");
  });

  it("keeps authority-qualified identifiers distinct (no cross-root collision)", () => {
    // The identifier is `<root-OID>:<ext>`, so two different providers that share
    // a local id extension under different assigning authorities do NOT collide.
    const a = providerDedupKey({
      name: "Clinic A",
      type: "organization",
      identifier: "1.2.840.111:100",
    });
    const b = providerDedupKey({
      name: "Clinic B",
      type: "organization",
      identifier: "1.2.840.222:100",
    });
    expect(a).toBe("id:1.2.840.111:100");
    expect(a).not.toBe(b);
  });

  it("does not collapse an org and an individual that share a name", () => {
    const org = providerDedupKey({
      name: "Sample Care East",
      type: "organization",
    });
    const person = providerDedupKey({
      name: "Sample Care East",
      type: "individual",
    });
    expect(org).not.toBe(person);
  });
});

describe("isUsableProvider / cleanProviderInput", () => {
  it("rejects a blank or nameless candidate", () => {
    expect(isUsableProvider(null)).toBe(false);
    expect(isUsableProvider({ name: "  " })).toBe(false);
    expect(cleanProviderInput({ name: "", type: "organization" })).toBeNull();
  });

  it("trims fields, blanks to null, normalizes npi digits", () => {
    expect(
      cleanProviderInput({
        name: "  QUEST   (BEAKER) ",
        type: "organization",
        npi: "  ",
        identifier: "",
        phone: " +1-555-010-0001 ",
        address: "  123 Example  Ave  ",
      })
    ).toEqual({
      name: "QUEST (BEAKER)",
      type: "organization",
      npi: null,
      identifier: null,
      phone: "+1-555-010-0001",
      address: "123 Example Ave",
    });
  });
});

describe("dedupeProviders", () => {
  it("collapses duplicates by global key, first-writer-wins", () => {
    const out = dedupeProviders([
      { name: "QUEST (BEAKER)", type: "organization" },
      { name: "quest (beaker)", type: "organization" }, // dup by name
      { name: "Rosalind Franklin", type: "individual", npi: "1000000002" },
      { name: "R Franklin", type: "individual", npi: "1000000002" }, // dup by NPI
      { name: "", type: "organization" }, // dropped (no name)
    ]);
    expect(out.map((p) => p.name)).toEqual([
      "QUEST (BEAKER)",
      "Rosalind Franklin",
    ]);
  });
});
