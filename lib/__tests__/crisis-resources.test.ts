import { describe, it, expect } from "vitest";
import {
  normalizeCrisisResources,
  parseCrisisResources,
  serializeCrisisResources,
  parseCrisisResourcesText,
  formatCrisisResourcesText,
  resolveCrisisResources,
  crisisFindingLine,
  hasConfiguredCrisisResources,
  CRISIS_FALLBACK_LINE,
  CRISIS_LEAD_LINE,
} from "@/lib/crisis-resources";

// #996 — the crisis-resources config is operator-owned and region-correct; there is
// NO hardcoded number anywhere, and an unconfigured instance resolves to the neutral
// fallback, never a fabricated line.
describe("normalizeCrisisResources", () => {
  it("drops rows with no contact and trims/caps", () => {
    expect(
      normalizeCrisisResources([
        { label: "  Line  ", contact: "  555-0100 " },
        { label: "No contact", contact: "" },
        { contact: "just a number" },
      ])
    ).toEqual([
      { label: "Line", contact: "555-0100" },
      { label: "", contact: "just a number" },
    ]);
  });
});

describe("text round-trip", () => {
  it("parses 'Label | contact' lines and re-formats them", () => {
    const text =
      "Local line | 555-0100\nEmergency services | 112\nbare 555-0111";
    const list = parseCrisisResourcesText(text);
    expect(list).toEqual([
      { label: "Local line", contact: "555-0100" },
      { label: "Emergency services", contact: "112" },
      { label: "", contact: "bare 555-0111" },
    ]);
    expect(formatCrisisResourcesText(list)).toBe(
      "Local line | 555-0100\nEmergency services | 112\nbare 555-0111"
    );
  });

  it("JSON serialize/parse is stable and tolerant of garbage", () => {
    const list = [{ label: "L", contact: "c" }];
    expect(parseCrisisResources(serializeCrisisResources(list))).toEqual(list);
    expect(parseCrisisResources("not json")).toEqual([]);
    expect(parseCrisisResources(null)).toEqual([]);
  });
});

describe("resolveCrisisResources", () => {
  const global = [{ label: "G", contact: "1" }];
  const override = [{ label: "O", contact: "2" }];
  it("prefers a non-empty override, else the global default", () => {
    expect(resolveCrisisResources(global, override)).toEqual(override);
    expect(resolveCrisisResources(global, null)).toEqual(global);
    expect(resolveCrisisResources(global, [])).toEqual(global);
    expect(resolveCrisisResources([], null)).toEqual([]);
  });
});

describe("crisisFindingLine", () => {
  it("includes the configured resources when present (no fabricated number)", () => {
    const line = crisisFindingLine([
      { label: "Local line", contact: "555-0100" },
    ]);
    expect(line).toContain(CRISIS_LEAD_LINE);
    expect(line).toContain("Local line: 555-0100");
    expect(line).not.toContain("988");
  });

  it("falls back to neutral guidance when unconfigured — never a number", () => {
    const line = crisisFindingLine([]);
    expect(line).toContain(CRISIS_FALLBACK_LINE);
    expect(line).not.toContain("988");
    expect(hasConfiguredCrisisResources([])).toBe(false);
  });
});
