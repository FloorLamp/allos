import { describe, it, expect } from "vitest";
import {
  medicationHitActions,
  appointmentHitActions,
  biomarkerHitActions,
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
    const actions = medicationHitActions(9, false);
    expect(actions).toEqual([
      { kind: "log-dose", label: "Log dose", entityId: 9 },
    ]);
    expect(actions.map((a) => a.kind)).not.toContain("refill");
  });

  it("targets the item id as the write action's entity", () => {
    for (const a of medicationHitActions(42, true)) {
      expect(a.entityId).toBe(42);
      expect(a.href).toBeUndefined();
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

describe("biomarkerHitActions", () => {
  it("navigates to the add form, focus param + name-prefilled and encoded", () => {
    const [action] = biomarkerHitActions("LDL Cholesterol");
    expect(action.kind).toBe("add-result");
    expect(action.label).toBe("Add result");
    expect(action.entityId).toBe(0);
    expect(action.href).toBe(
      "/results/biomarkers?new=1&name=LDL%20Cholesterol"
    );
  });

  it("URL-encodes a name with reserved characters", () => {
    const [action] = biomarkerHitActions("TG/HDL Ratio");
    expect(action.href).toBe("/results/biomarkers?new=1&name=TG%2FHDL%20Ratio");
  });
});
