import { describe, it, expect } from "vitest";
import {
  scanText,
  scanLine,
  isLuhnValidNpi,
  isSyntheticNpi,
  isLikelyRealPhone,
  isLikelyRealSsn,
  ALLOW_MARKER,
} from "@/lib/phi-scan";

// NOTE: every literal below is SYNTHETIC — a scanner INPUT, not committed PHI.
// This file is excluded from the runtime scan (scripts/phi-scan.ts DEFAULT_IGNORES)
// precisely because it must contain PHI-SHAPED values to exercise the detector.

// A Luhn-valid NPI that is NOT structurally synthetic (not all-same / sequential),
// built to pass the 80840 check digit. Obviously fake by construction, real-shaped.
const REAL_SHAPED_NPI = "1245319599";
// Random 10-digit test number that fails the NPI Luhn check.
const RANDOM_NPI = "1000000001";

describe("NPI detection", () => {
  it("accepts the 80840 Luhn check for a valid NPI", () => {
    expect(isLuhnValidNpi(REAL_SHAPED_NPI)).toBe(true);
  });

  it("rejects a random 10-digit number as an NPI", () => {
    expect(isLuhnValidNpi(RANDOM_NPI)).toBe(false);
  });

  it("treats all-same-digit and sequential NPIs as synthetic", () => {
    expect(isSyntheticNpi("9999999995")).toBe(true); // all 9s (Luhn-valid)
    expect(isSyntheticNpi("1234567893")).toBe(true); // 123456789 + check
    expect(isSyntheticNpi(REAL_SHAPED_NPI)).toBe(false);
  });

  it("flags a Luhn-valid, non-synthetic NPI", () => {
    const findings = scanText(`provider npi="${REAL_SHAPED_NPI}"`);
    expect(findings.map((f) => f.kind)).toContain("npi");
  });

  it("does not flag a random (Luhn-invalid) 10-digit number", () => {
    expect(scanText(`id=${RANDOM_NPI}`)).toHaveLength(0);
  });

  it("does not flag a Luhn-valid but structurally-synthetic NPI", () => {
    expect(scanText(`extension="9999999995"`)).toHaveLength(0);
    expect(scanText(`npi: "1234567893"`)).toHaveLength(0);
  });

  it("never emits the raw NPI in the redacted snippet", () => {
    const [finding] = scanText(`npi="${REAL_SHAPED_NPI}"`);
    expect(finding.snippetRedacted).not.toContain(REAL_SHAPED_NPI);
    expect(finding.snippetRedacted).toContain("•");
  });
});

describe("phone detection", () => {
  it("does not flag a reserved 555-01xx fake phone", () => {
    expect(scanText("call (415) 555-0132")).toHaveLength(0);
    expect(scanText("tel:+1-415-555-0100")).toHaveLength(0);
  });

  it("does not flag movie-style 555 exchange (e.g. 555-1234)", () => {
    expect(scanText("(212) 555-1234")).toHaveLength(0);
  });

  it("does not flag an unassignable area code 555 or invalid exchange", () => {
    expect(scanText("tel:+1-555-010-0001")).toHaveLength(0);
  });

  it("flags a structurally-valid, real-looking phone number", () => {
    const findings = scanText("reach us at (415) 867-5309");
    expect(findings.map((f) => f.kind)).toContain("phone");
  });

  it("classifies NANP validity correctly", () => {
    expect(isLikelyRealPhone("415", "867", "5309")).toBe(true);
    expect(isLikelyRealPhone("415", "555", "0132")).toBe(false); // fictional exch
    expect(isLikelyRealPhone("555", "867", "5309")).toBe(false); // fake area
    expect(isLikelyRealPhone("115", "867", "5309")).toBe(false); // area leads 1
    expect(isLikelyRealPhone("415", "067", "5309")).toBe(false); // exch leads 0
  });

  it("never emits the raw phone in the redacted snippet", () => {
    const [finding] = scanText("(415) 867-5309");
    expect(finding.snippetRedacted).not.toContain("867-5309");
    expect(finding.snippetRedacted).toContain("•");
  });
});

describe("SSN detection", () => {
  it("does not flag SSNs with invalid area numbers", () => {
    expect(scanText("ssn 000-12-3456")).toHaveLength(0);
    expect(scanText("ssn 666-12-3456")).toHaveLength(0);
    expect(scanText("ssn 900-12-3456")).toHaveLength(0);
    expect(scanText("ssn 999-99-9999")).toHaveLength(0);
  });

  it("does not flag SSNs with a zero group or serial", () => {
    expect(scanText("123-00-4567")).toHaveLength(0);
    expect(scanText("123-45-0000")).toHaveLength(0);
  });

  it("flags a validly-shaped SSN", () => {
    const findings = scanText("patient ssn 123-45-6789");
    expect(findings.map((f) => f.kind)).toContain("ssn");
  });

  it("classifies SSN validity correctly", () => {
    expect(isLikelyRealSsn("123", "45", "6789")).toBe(true);
    expect(isLikelyRealSsn("000", "45", "6789")).toBe(false);
    expect(isLikelyRealSsn("666", "45", "6789")).toBe(false);
    expect(isLikelyRealSsn("900", "45", "6789")).toBe(false);
    expect(isLikelyRealSsn("123", "00", "6789")).toBe(false);
    expect(isLikelyRealSsn("123", "45", "0000")).toBe(false);
  });

  it("never emits the raw SSN in the redacted snippet", () => {
    const [finding] = scanText("123-45-6789");
    expect(finding.snippetRedacted).not.toContain("123-45-6789");
    expect(finding.snippetRedacted).toContain("•");
  });
});

describe("allowlist marker", () => {
  it(`suppresses findings on a line carrying "${ALLOW_MARKER}"`, () => {
    const line = `npi="${REAL_SHAPED_NPI}" // ${ALLOW_MARKER}: synthetic test id`;
    expect(scanLine(line, 1)).toHaveLength(0);
    expect(scanText(line)).toHaveLength(0);
  });

  it("does not suppress an adjacent line without the marker", () => {
    const text = [
      `first ${ALLOW_MARKER} npi="${REAL_SHAPED_NPI}"`,
      `second npi="${REAL_SHAPED_NPI}"`,
    ].join("\n");
    const findings = scanText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });
});

describe("denylist", () => {
  it("flags a passed-in literal (case-insensitive) and masks it", () => {
    const [finding] = scanText("seen at Fictional Clinic today", {
      denylist: ["fictional clinic"],
    });
    expect(finding.kind).toBe("denylist");
    expect(finding.snippetRedacted).not.toContain("Fictional Clinic");
  });

  it("does nothing without a denylist", () => {
    expect(scanText("seen at Fictional Clinic today")).toHaveLength(0);
  });
});

describe("line numbers", () => {
  it("reports the 1-based line of a finding", () => {
    const text = ["ok", "ok", "ssn 123-45-6789"].join("\n");
    const findings = scanText(text);
    expect(findings[0].line).toBe(3);
  });
});
