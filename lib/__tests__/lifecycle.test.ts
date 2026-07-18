import { describe, it, expect } from "vitest";
import {
  isHiddenUnderPolicy,
  LIFECYCLE_SUPPRESSION_POLICIES,
  MARKER_LIFECYCLE_ACTIONS,
  type LifecycleSuppressionPolicy,
} from "../lifecycle";
import { ESCALATION_SUPPRESSION_POLICY } from "../notifications/escalation";
import type { SuppressionRecord } from "../upcoming-suppress";

const TODAY = "2026-07-18";
const dismissed: SuppressionRecord = {
  snooze_until: null,
  dismissed_at: "2026-07-01T00:00:00Z",
};
const liveSnooze: SuppressionRecord = {
  snooze_until: "2026-07-25",
  dismissed_at: null,
};
const expiredSnooze: SuppressionRecord = {
  snooze_until: "2026-07-10",
  dismissed_at: null,
};

describe("isHiddenUnderPolicy — normal", () => {
  it("a dismiss hides indefinitely", () => {
    expect(isHiddenUnderPolicy("normal", dismissed, TODAY)).toBe(true);
  });
  it("a live snooze hides; an expired one does not", () => {
    expect(isHiddenUnderPolicy("normal", liveSnooze, TODAY)).toBe(true);
    expect(isHiddenUnderPolicy("normal", expiredSnooze, TODAY)).toBe(false);
  });
  it("no record → not hidden", () => {
    expect(isHiddenUnderPolicy("normal", undefined, TODAY)).toBe(false);
  });
});

describe("isHiddenUnderPolicy — snooze-only (overdue follow-up, #700)", () => {
  it("resists an indefinite dismiss but honors a live snooze", () => {
    expect(isHiddenUnderPolicy("snooze-only", dismissed, TODAY)).toBe(false);
    expect(isHiddenUnderPolicy("snooze-only", liveSnooze, TODAY)).toBe(true);
    expect(isHiddenUnderPolicy("snooze-only", expiredSnooze, TODAY)).toBe(
      false
    );
  });
});

// The NON-NEGOTIABLE #449/#942 safety carve-out. A safety-ungated signal (dose
// reminders + missed-dose escalation) can NEVER be hidden by the findings bus — no
// dismiss, no snooze, nothing on upcoming_dismissals silences it. If this test ever
// fails, a page dismissal could silence a possibly-critical medication signal.
describe("isHiddenUnderPolicy — safety-ungated (SAFETY CARVE-OUT)", () => {
  it("is ALWAYS false, for every possible suppression record", () => {
    for (const rec of [
      undefined,
      dismissed,
      liveSnooze,
      expiredSnooze,
      { snooze_until: "2999-12-31", dismissed_at: "2026-07-01T00:00:00Z" },
    ] as (SuppressionRecord | undefined)[]) {
      expect(isHiddenUnderPolicy("safety-ungated", rec, TODAY)).toBe(false);
    }
  });
});

describe("dose escalation is the first safety-ungated lifecycle tenant (#942)", () => {
  it("declares the safety-ungated policy", () => {
    expect(ESCALATION_SUPPRESSION_POLICY).toBe("safety-ungated");
  });
  it("a page dismissal can never hide the escalation signal", () => {
    // Route the escalation's DECLARED policy through the shared gate against an
    // active dismissal — the machine-checked expression of "escalation stays
    // never-bus-gated". Pairs with the notify-orchestrators end-to-end harness case.
    expect(
      isHiddenUnderPolicy(ESCALATION_SUPPRESSION_POLICY, dismissed, TODAY)
    ).toBe(false);
    expect(
      isHiddenUnderPolicy(ESCALATION_SUPPRESSION_POLICY, liveSnooze, TODAY)
    ).toBe(false);
  });
});

describe("lifecycle vocabulary is enumerable", () => {
  it("the policy set is the closed three-tier list", () => {
    expect([...LIFECYCLE_SUPPRESSION_POLICIES]).toEqual([
      "normal",
      "snooze-only",
      "safety-ungated",
    ]);
    // The escalation tenant's declared policy is one of the enumerated tiers.
    const policies: readonly LifecycleSuppressionPolicy[] =
      LIFECYCLE_SUPPRESSION_POLICIES;
    expect(policies).toContain(ESCALATION_SUPPRESSION_POLICY);
  });
  it("the marker state machine is set/clear/freeze", () => {
    expect([...MARKER_LIFECYCLE_ACTIONS]).toEqual(["set", "clear", "freeze"]);
  });
});
