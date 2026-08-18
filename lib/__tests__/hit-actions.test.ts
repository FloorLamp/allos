import { describe, it, expect } from "vitest";
import {
  medicationHitActions,
  appointmentHitActions,
  clinicalResultHitActions,
} from "@/lib/hit-actions";

// Per-hit command-palette actions (issue #662). Pure matchers — the DB fan-out
// attaches them, the palette dispatches each kind to the existing gated action.

describe("medicationHitActions", () => {
  it("always offers Log dose, and Refill only when supply is tracked", () => {
    expect(medicationHitActions(7, true)).toEqual([
      { kind: "log-dose", label: "Log dose", entityId: 7 },
      { kind: "refill", label: "Refill", entityId: 7 },
    ]);
  });

  it("omits Refill for an untracked medication", () => {
    expect(medicationHitActions(9, false)).toEqual([
      { kind: "log-dose", label: "Log dose", entityId: 9 },
    ]);
  });

  it("targets the item id as the write action's entity", () => {
    for (const a of medicationHitActions(42, true)) {
      expect(a.entityId).toBe(42);
    }
  });
});

describe("appointmentHitActions", () => {
  it("offers Mark complete only while scheduled", () => {
    expect(appointmentHitActions(3, "scheduled")).toEqual([
      { kind: "complete", label: "Mark complete", entityId: 3 },
    ]);
  });

  it("offers nothing for a completed or cancelled appointment", () => {
    expect(appointmentHitActions(3, "completed")).toEqual([]);
    expect(appointmentHitActions(3, "cancelled")).toEqual([]);
  });
});

describe("clinicalResultHitActions", () => {
  it("navigates to the add form, focus param + name-prefilled and encoded", () => {
    expect(clinicalResultHitActions("LDL Cholesterol")).toEqual([
      {
        kind: "add-result",
        label: "Add result",
        entityId: 0,
        href: "/results/clinical-results?new=1&name=LDL%20Cholesterol",
      },
    ]);
  });

  it("URL-encodes a name with reserved characters", () => {
    const [action] = clinicalResultHitActions("TG/HDL Ratio");
    expect(action.href).toBe(
      "/results/clinical-results?new=1&name=TG%2FHDL%20Ratio"
    );
  });
});
