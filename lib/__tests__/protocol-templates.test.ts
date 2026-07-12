import { describe, it, expect } from "vitest";
import {
  PROTOCOL_TEMPLATES,
  SUN_EXPOSURE_TEMPLATE,
  protocolTemplateById,
} from "../protocol-templates";

describe("protocol templates", () => {
  it("registers the sun-exposure template with a vitamin-D outcome", () => {
    expect(PROTOCOL_TEMPLATES).toContain(SUN_EXPOSURE_TEMPLATE);
    expect(SUN_EXPOSURE_TEMPLATE.outcomeKeys).toContain(
      "biomarker:Vitamin D, 25-Hydroxy"
    );
    // Biomarker keys use the protocol-metrics `biomarker:<canonical>` form.
    for (const k of SUN_EXPOSURE_TEMPLATE.outcomeKeys) {
      expect(k.startsWith("biomarker:") || k.startsWith("metric:")).toBe(true);
    }
  });

  it("copy stays observational, not prescriptive", () => {
    expect(SUN_EXPOSURE_TEMPLATE.notes).not.toMatch(
      /should|must|\bmore sun\b/i
    );
    expect(SUN_EXPOSURE_TEMPLATE.notes).toMatch(/observational/i);
  });

  it("looks up by id, null for unknown/blank", () => {
    expect(protocolTemplateById("sun-exposure")).toBe(SUN_EXPOSURE_TEMPLATE);
    expect(protocolTemplateById("nope")).toBeNull();
    expect(protocolTemplateById(null)).toBeNull();
    expect(protocolTemplateById(undefined)).toBeNull();
  });
});
