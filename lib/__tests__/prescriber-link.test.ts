import { describe, it, expect } from "vitest";
import {
  resolveExactIndividualProvider,
  classifyPrescriberLink,
  type RegistryProviderRow,
} from "../prescriber-link";

// Pure resolve rule for med → prescriber (individual) linking (#1051). The write-time
// resolver links ONLY on an unambiguous exact individual match (or an NPI hit); an
// org-only name never links (it yields the fix-type suggestion); a near-miss proposes
// without linking; empty text no-ops.

const individual = (
  id: number,
  name: string,
  npi: string | null = null
): RegistryProviderRow => ({
  id,
  type: "individual",
  name,
  npi,
});
const org = (id: number, name: string): RegistryProviderRow => ({
  id,
  type: "organization",
  name,
  npi: null,
});

describe("resolveExactIndividualProvider (write-time)", () => {
  it("links an exact individual name match", () => {
    const rows = [individual(5, "Sarah Chen"), org(6, "Sample Care East")];
    expect(resolveExactIndividualProvider("Sarah Chen", null, rows)).toBe(5);
  });

  it("is case- and whitespace-insensitive", () => {
    const rows = [individual(5, "Sarah Chen")];
    expect(resolveExactIndividualProvider("  sarah   chen ", null, rows)).toBe(
      5
    );
  });

  it("NEVER links to an organization of the same name (semantics decision (a))", () => {
    const rows = [org(6, "Dr. Chen")];
    expect(resolveExactIndividualProvider("Dr. Chen", null, rows)).toBeNull();
  });

  it("links on an NPI hit even when the name differs", () => {
    const rows = [individual(9, "Samuel Chen", "1234567893")];
    expect(resolveExactIndividualProvider("S. Chen", "1234567893", rows)).toBe(
      9
    );
  });

  it("does NOT link when two individuals share the name (ambiguous)", () => {
    const rows = [individual(1, "Sarah Chen"), individual(2, "Sarah Chen")];
    expect(resolveExactIndividualProvider("Sarah Chen", null, rows)).toBeNull();
  });

  it("empty text no-ops", () => {
    expect(
      resolveExactIndividualProvider("", null, [individual(1, "X")])
    ).toBeNull();
    expect(resolveExactIndividualProvider("  ", null, [])).toBeNull();
  });
});

describe("classifyPrescriberLink (suggest-and-accept)", () => {
  it("classifies an exact individual as already-linkable", () => {
    const rows = [individual(5, "Sarah Chen")];
    expect(classifyPrescriberLink("Sarah Chen", rows)).toEqual({
      kind: "exact",
      providerId: 5,
    });
  });

  it("flags an org-only match as a fix-type suggestion", () => {
    const rows = [org(6, "Dr. Chen")];
    expect(classifyPrescriberLink("Dr. Chen", rows)).toEqual({
      kind: "org-mistype",
      providerId: 6,
      providerName: "Dr. Chen",
    });
  });

  it("proposes a near-miss without linking (S. Chen → Sarah Chen)", () => {
    const rows = [individual(5, "Sarah Chen, MD")];
    expect(classifyPrescriberLink("S. Chen", rows)).toEqual({
      kind: "near-miss",
      providerId: 5,
      providerName: "Sarah Chen, MD",
    });
  });

  it("does not near-miss across different surnames", () => {
    const rows = [individual(5, "Sarah Rivera")];
    expect(classifyPrescriberLink("S. Chen", rows)).toEqual({ kind: "none" });
  });

  it("empty text is none", () => {
    expect(classifyPrescriberLink("", [individual(1, "X")])).toEqual({
      kind: "none",
    });
  });
});
