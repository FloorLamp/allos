import { describe, expect, it } from "vitest";
import {
  buildAdvanceDirectives,
  codeStatusDetail,
  codeStatusLabel,
  hasAdvanceDirectives,
  normalizeCodeStatus,
  normalizeOrganDonor,
  organDonorLabel,
  CODE_STATUSES,
  ORGAN_DONOR_STATUSES,
} from "@/lib/advance-directives";

// The advance-directive summary (#1848): the facts an ED asks for first when the
// patient can't speak. The decisions worth pinning are all about NOT overclaiming —
// an unreadable enum value, a blank, or a dangling effective date must never print
// as if it were an answer.

const EMPTY_INPUT = {
  codeStatus: null,
  codeStatusEffective: null,
  codeStatusNote: null,
  proxyName: null,
  proxyRelation: null,
  proxyPhone: null,
  organDonor: null,
  documentsAt: null,
};

describe("normalizeCodeStatus", () => {
  it("accepts every declared key, case- and space-insensitively", () => {
    for (const c of CODE_STATUSES) {
      expect(normalizeCodeStatus(c.key)).toBe(c.key);
      expect(normalizeCodeStatus(` ${c.key.toUpperCase()} `)).toBe(c.key);
    }
  });

  it("refuses anything else rather than passing it through", () => {
    expect(normalizeCodeStatus("dnr-plus")).toBeNull();
    expect(normalizeCodeStatus("")).toBeNull();
    expect(normalizeCodeStatus(undefined)).toBeNull();
  });
});

describe("normalizeOrganDonor", () => {
  it("accepts the declared keys and refuses the rest", () => {
    for (const o of ORGAN_DONOR_STATUSES)
      expect(normalizeOrganDonor(o.key)).toBe(o.key);
    expect(normalizeOrganDonor("maybe")).toBeNull();
    expect(normalizeOrganDonor(null)).toBeNull();
  });
});

describe("labels", () => {
  it("every code status has a label and a plain-language detail", () => {
    for (const c of CODE_STATUSES) {
      expect(codeStatusLabel(c.key)).toBe(c.label);
      expect(codeStatusDetail(c.key)).toBe(c.detail);
    }
  });

  it("labels the donor statuses", () => {
    expect(organDonorLabel("registered")).toBe("Registered organ donor");
    expect(organDonorLabel("declined")).toBe("Not an organ donor");
  });
});

describe("buildAdvanceDirectives", () => {
  it("trims and keeps what was recorded", () => {
    const d = buildAdvanceDirectives({
      codeStatus: "dnr-dni",
      codeStatusEffective: "2026-02-01",
      codeStatusNote: "  Signed POLST on file  ",
      proxyName: " Robin Reyes ",
      proxyRelation: " Spouse ",
      proxyPhone: " 555-0100 ",
      organDonor: "registered",
      documentsAt: " POLST on the fridge ",
    });
    expect(d.codeStatus).toBe("dnr-dni");
    expect(d.codeStatusEffective).toBe("2026-02-01");
    expect(d.codeStatusNote).toBe("Signed POLST on file");
    expect(d.proxy).toEqual({
      name: "Robin Reyes",
      relation: "Spouse",
      phone: "555-0100",
    });
    expect(d.organDonor).toBe("registered");
    expect(d.documentsAt).toBe("POLST on the fridge");
  });

  it("drops an effective date with no code status — a date alone asserts nothing", () => {
    const d = buildAdvanceDirectives({
      ...EMPTY_INPUT,
      codeStatusEffective: "2026-02-01",
    });
    expect(d.codeStatus).toBeNull();
    expect(d.codeStatusEffective).toBeNull();
  });

  it("collapses the proxy to null unless a name or phone is present", () => {
    expect(
      buildAdvanceDirectives({ ...EMPTY_INPUT, proxyRelation: "Spouse" }).proxy
    ).toBeNull();
    expect(
      buildAdvanceDirectives({ ...EMPTY_INPUT, proxyPhone: "555-0100" }).proxy
    ).toEqual({ name: "", relation: null, phone: "555-0100" });
  });

  it("nulls an unreadable stored enum rather than rendering it", () => {
    const d = buildAdvanceDirectives({
      ...EMPTY_INPUT,
      codeStatus: "partial-code",
      organDonor: "unknown",
    });
    expect(d.codeStatus).toBeNull();
    expect(d.organDonor).toBeNull();
  });

  it("treats whitespace-only free text as unrecorded", () => {
    const d = buildAdvanceDirectives({
      ...EMPTY_INPUT,
      codeStatusNote: "   ",
      documentsAt: "\n",
    });
    expect(d.codeStatusNote).toBeNull();
    expect(d.documentsAt).toBeNull();
  });
});

describe("hasAdvanceDirectives", () => {
  it("is false for null and for an all-blank summary", () => {
    expect(hasAdvanceDirectives(null)).toBe(false);
    expect(hasAdvanceDirectives(buildAdvanceDirectives(EMPTY_INPUT))).toBe(
      false
    );
  });

  it("is true as soon as any single fact is recorded", () => {
    const cases = [
      { codeStatus: "full" },
      { codeStatusNote: "Ask my daughter" },
      { proxyPhone: "555-0100" },
      { organDonor: "declined" },
      { documentsAt: "Safe deposit box" },
    ];
    for (const c of cases) {
      expect(
        hasAdvanceDirectives(buildAdvanceDirectives({ ...EMPTY_INPUT, ...c })),
        JSON.stringify(c)
      ).toBe(true);
    }
  });
});
