// Pure tier — the shared kind × channel matrix gate (#928). The gate that decides
// whether a kind reaches a channel is `isKindEnabled` (channel-agnostic since the HA
// channel first shipped it), now driving all three columns; the push undeliverable
// rule and the safety-kind classification are the matrix's other pure pieces.

import { describe, it, expect } from "vitest";
import {
  isKindEnabled,
  isSafetyKind,
  SAFETY_NOTIFICATION_KINDS,
  TOGGLEABLE_NOTIFICATION_KINDS,
  TOGGLEABLE_HA_KINDS,
} from "@/lib/notifications/home-assistant-core";
import { isPushDeliverableKind } from "@/lib/notifications/push-core";

describe("isKindEnabled (shared matrix gate)", () => {
  it("is enabled-unless-disabled: absence of a kind means it's on", () => {
    expect(isKindEnabled("dose", [])).toBe(true);
    expect(isKindEnabled("dose", ["refill"])).toBe(true);
    expect(isKindEnabled("refill", ["refill"])).toBe(false);
  });

  it("keeps `test` always on — a send-test can never be gated off", () => {
    expect(isKindEnabled("test", ["test", "dose", "refill"])).toBe(true);
  });

  it("treats an unset kind as `other` (deliverable unless `other` is disabled)", () => {
    expect(isKindEnabled(undefined, [])).toBe(true);
    expect(isKindEnabled(undefined, ["other"])).toBe(false);
  });
});

describe("push undeliverable cells", () => {
  it("marks the button-only food kind as not push-deliverable", () => {
    expect(isPushDeliverableKind("food")).toBe(false);
  });
  it("keeps content-bearing kinds push-deliverable", () => {
    expect(isPushDeliverableKind("dose")).toBe(true);
    expect(isPushDeliverableKind("refill")).toBe(true);
    expect(isPushDeliverableKind(undefined)).toBe(true);
  });
});

describe("safety kinds", () => {
  it("classifies dose reminders + missed-dose escalation (+ redose) as safety", () => {
    expect(isSafetyKind("dose")).toBe(true);
    expect(isSafetyKind("escalation")).toBe(true);
    expect(isSafetyKind("redose")).toBe(true);
    expect([...SAFETY_NOTIFICATION_KINDS].sort()).toEqual([
      "dose",
      "escalation",
      "redose",
    ]);
  });
  it("does not classify observational kinds as safety", () => {
    for (const k of ["refill", "preventive", "workout", "digest", "milestone"] as const)
      expect(isSafetyKind(k)).toBe(false);
  });
});

describe("shared toggleable-kind registry", () => {
  it("is the same list the HA channel historically used (back-compat alias)", () => {
    expect(TOGGLEABLE_NOTIFICATION_KINDS).toBe(TOGGLEABLE_HA_KINDS);
  });
  it("excludes `test` and the internal `other` kind", () => {
    const kinds = TOGGLEABLE_NOTIFICATION_KINDS.map((k) => k.kind);
    expect(kinds).not.toContain("test");
    expect(kinds).not.toContain("other");
  });
});
