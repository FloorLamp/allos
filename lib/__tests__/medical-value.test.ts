import { describe, it, expect } from "vitest";
import { medicalValueCaret, medicalValueFlagText } from "@/lib/medical-value";
import { flagLabel } from "@/lib/reference-range";

// The severity word beside a flagged value (#1220/#2315).
//
// The caret's DIRECTION is a shape and survives color blindness; the red-vs-amber
// SEVERITY — "High" versus "Above optimal" — did not. `showFlagLabel` makes the word
// visible on the surfaces that list both classes intermixed, and the two rules this
// module exists to keep are asserted here: visible INSTEAD OF sr-only, and
// byte-identical behavior for every call site that does not opt in.

const NON_NORMAL = [
  "high",
  "low",
  "abnormal",
  "non-optimal",
  "non-optimal-high",
  "non-optimal-low",
  "immune",
] as const;

describe("medicalValueCaret", () => {
  it("points up for clinical high and above-optimal", () => {
    expect(medicalValueCaret("high")).toBe("up");
    expect(medicalValueCaret("non-optimal-high")).toBe("up");
  });

  it("points down for clinical low and below-optimal", () => {
    expect(medicalValueCaret("low")).toBe("down");
    expect(medicalValueCaret("non-optimal-low")).toBe("down");
  });

  it("claims no direction the flag does not state", () => {
    // Legacy directionless "non-optimal" re-derives to a directional flag on the
    // next reconcile; a qualitative "abnormal" has no direction at all.
    expect(medicalValueCaret("non-optimal")).toBeNull();
    expect(medicalValueCaret("abnormal")).toBeNull();
    expect(medicalValueCaret("immune")).toBeNull();
    expect(medicalValueCaret("normal")).toBeNull();
    expect(medicalValueCaret(null)).toBeNull();
  });
});

describe("medicalValueFlagText without showFlagLabel (byte-identical to pre-#2315)", () => {
  it("emits an sr-only label for the directional flags, and only those", () => {
    for (const flag of ["high", "low", "non-optimal-high", "non-optimal-low"]) {
      expect(medicalValueFlagText(flag)).toEqual({
        label: flagLabel(flag),
        visible: false,
      });
    }
  });

  it("emits nothing for a flag that carries no caret", () => {
    // Exactly the pre-#2315 condition: the label only ever accompanied a caret.
    expect(medicalValueFlagText("abnormal")).toBeNull();
    expect(medicalValueFlagText("non-optimal")).toBeNull();
    expect(medicalValueFlagText("immune")).toBeNull();
    expect(medicalValueFlagText("normal")).toBeNull();
    expect(medicalValueFlagText(null)).toBeNull();
  });

  it("defaults to off — the prop is opt-in per call site", () => {
    expect(medicalValueFlagText("high")).toEqual(
      medicalValueFlagText("high", false)
    );
  });
});

describe("medicalValueFlagText with showFlagLabel", () => {
  it("renders the label visibly for every non-normal flag", () => {
    for (const flag of NON_NORMAL) {
      expect(medicalValueFlagText(flag, true)).toEqual({
        label: flagLabel(flag),
        visible: true,
      });
    }
  });

  it("widens to the directionless flags a caret never covered", () => {
    // This is what lets RecentLabsWidget drop its parallel label: its own map
    // labelled "Abnormal"/"Immune"/"Non-optimal" too.
    expect(medicalValueFlagText("abnormal", true)).toEqual({
      label: "Abnormal",
      visible: true,
    });
    expect(medicalValueFlagText("immune", true)).toEqual({
      label: "Immune",
      visible: true,
    });
  });

  it("never returns a second sr-only copy — the severity is announced once", () => {
    // The shape itself is the guarantee: ONE result, one `visible` verdict. A
    // visible label and an sr-only twin cannot both be expressed.
    for (const flag of NON_NORMAL) {
      const text = medicalValueFlagText(flag, true);
      expect(text?.visible).toBe(true);
    }
  });

  it("still says nothing about a value it did not flag", () => {
    expect(medicalValueFlagText("normal", true)).toBeNull();
    expect(medicalValueFlagText(null, true)).toBeNull();
    expect(medicalValueFlagText(undefined, true)).toBeNull();
  });
});
