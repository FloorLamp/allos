import { describe, it, expect } from "vitest";
import {
  shouldOfferCreateVisit,
  isCreateVisitDomain,
  CREATE_VISIT_DOMAINS,
  CREATE_VISIT_ENCOUNTER_KEY,
  type CreateVisitCandidate,
} from "@/lib/visit-link-suggest";
import { matchRuleKeys } from "@/lib/preventive-inference";

// PURE tier (#1099): the "Create a visit from this record?" decision. Some records
// imply a visit (optical Rx / completed dental procedure / imaging study); when one is
// dated D with NO encounter that day, offer to create a skeleton visit — never
// auto-create. An existing same-day encounter defers to #1050's link path; a declined
// offer never re-nags.

const rec = (
  over: Partial<CreateVisitCandidate> = {}
): CreateVisitCandidate => ({
  domain: "optical",
  id: 1,
  external_id: null,
  date: "2026-05-12",
  label: "glasses",
  ...over,
});

describe("shouldOfferCreateVisit — the prompt condition", () => {
  it("offers when the record is dated, undeclined, and has no same-day encounter", () => {
    expect(shouldOfferCreateVisit(rec(), 0, false)).toBe(true);
  });

  it("does NOT offer when an encounter already exists that day (#1050 link path)", () => {
    expect(shouldOfferCreateVisit(rec(), 1, false)).toBe(false);
    // ≥2 same-day → #1050's picker rule owns it, still no create.
    expect(shouldOfferCreateVisit(rec(), 2, false)).toBe(false);
  });

  it("does NOT offer once the create offer was declined (remembered)", () => {
    expect(shouldOfferCreateVisit(rec(), 0, true)).toBe(false);
  });

  it("does NOT offer an undated record", () => {
    expect(shouldOfferCreateVisit(rec({ date: null }), 0, false)).toBe(false);
  });

  it("works across every create domain", () => {
    for (const domain of CREATE_VISIT_DOMAINS) {
      expect(shouldOfferCreateVisit(rec({ domain }), 0, false)).toBe(true);
    }
  });
});

describe("create-visit domain guard + sentinel", () => {
  it("accepts only the three visit-implying domains", () => {
    expect(isCreateVisitDomain("optical")).toBe(true);
    expect(isCreateVisitDomain("dental")).toBe(true);
    expect(isCreateVisitDomain("imaging")).toBe(true);
    expect(isCreateVisitDomain("record")).toBe(false);
    expect(isCreateVisitDomain("medication")).toBe(false);
    expect(isCreateVisitDomain("")).toBe(false);
  });

  it("the create sentinel can never collide with a real encounter token", () => {
    expect(CREATE_VISIT_ENCOUNTER_KEY.startsWith("id:")).toBe(false);
    expect(CREATE_VISIT_ENCOUNTER_KEY.startsWith("ext:")).toBe(false);
  });
});

// The derived encounter's `type` text is what feeds the preventive concept map. A
// derived vision/dental visit must be concept-map-matchable so it satisfies the
// matching visit rule via the NORMAL encounter path (#1099/#1098) — guard the exact
// strings the DB layer sets here so a future edit that breaks the match fails a pure
// test, not silently in production.
describe("derived encounter type satisfies the matching visit rule (normal path)", () => {
  it("'Eye exam' satisfies vision_exam as a visit-kind record", () => {
    expect(matchRuleKeys({ name: "Eye exam" }, ["visit"])).toContain(
      "vision_exam"
    );
  });

  it("'Dental exam' satisfies dental_cleaning as a visit-kind record", () => {
    expect(matchRuleKeys({ name: "Dental exam" }, ["visit"])).toContain(
      "dental_cleaning"
    );
  });
});
