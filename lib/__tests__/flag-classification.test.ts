import { describe, expect, it } from "vitest";
import {
  flagLabel,
  flagTone,
  isNonOptimal,
  isOutOfRange,
  type FlagTone,
} from "@/lib/reference-range";
import type { MedicalFlag } from "@/lib/types";

// The canonical flag partition (issue #306). These tests pin the ONE source of
// truth every surface now routes through, so a new flag value forces a decision
// here instead of silently falling through differently per surface.

// Every MedicalFlag value plus the non-flag inputs the display code can hand us.
const ALL_FLAGS: MedicalFlag[] = [
  "normal",
  "high",
  "low",
  "abnormal",
  "immune",
  "non-optimal",
  "non-optimal-high",
  "non-optimal-low",
];

// The neutral (default-tone) flags: neither out-of-range nor non-optimal. "immune"
// is a GOOD durable-immunity status (#544), so it joins "normal" in this tier.
const NEUTRAL_FLAGS: MedicalFlag[] = ["normal", "immune"];

describe("isOutOfRange", () => {
  it("is exactly the clinical high/low/abnormal tier", () => {
    expect(isOutOfRange("high")).toBe(true);
    expect(isOutOfRange("low")).toBe(true);
    expect(isOutOfRange("abnormal")).toBe(true);
  });

  it("excludes non-optimal, normal, and absent flags", () => {
    expect(isOutOfRange("non-optimal")).toBe(false);
    expect(isOutOfRange("non-optimal-high")).toBe(false);
    expect(isOutOfRange("non-optimal-low")).toBe(false);
    expect(isOutOfRange("normal")).toBe(false);
    expect(isOutOfRange(null)).toBe(false);
    expect(isOutOfRange(undefined)).toBe(false);
  });

  it("partitions with isNonOptimal — no flag is both, none of the six abnormal is neither", () => {
    for (const f of ALL_FLAGS) {
      expect(isOutOfRange(f) && isNonOptimal(f)).toBe(false);
    }
    // Every recognized concern flag lands in exactly one of the two tiers. The
    // neutral flags (normal, immune) are in neither.
    const abnormal = ALL_FLAGS.filter((f) => !NEUTRAL_FLAGS.includes(f));
    for (const f of abnormal) {
      expect(isOutOfRange(f) || isNonOptimal(f)).toBe(true);
    }
    for (const f of NEUTRAL_FLAGS) {
      expect(isOutOfRange(f) || isNonOptimal(f)).toBe(false);
    }
  });
});

describe("flagTone", () => {
  it("maps out-of-range → bad, non-optimal → warn, else default", () => {
    const cases: Record<MedicalFlag, FlagTone> = {
      high: "bad",
      low: "bad",
      abnormal: "bad",
      "non-optimal": "warn",
      "non-optimal-high": "warn",
      "non-optimal-low": "warn",
      normal: "default",
      immune: "default",
    };
    for (const f of ALL_FLAGS) {
      expect(flagTone(f)).toBe(cases[f]);
    }
  });

  it("treats null/undefined/unknown as default (neutral)", () => {
    expect(flagTone(null)).toBe("default");
    expect(flagTone(undefined)).toBe("default");
    expect(flagTone("something-new")).toBe("default");
  });

  it("agrees with the predicates for every flag", () => {
    for (const f of ALL_FLAGS) {
      if (isOutOfRange(f)) expect(flagTone(f)).toBe("bad");
      else if (isNonOptimal(f)) expect(flagTone(f)).toBe("warn");
      else expect(flagTone(f)).toBe("default");
    }
  });
});

describe("flagLabel", () => {
  it("maps each recognized flag to its single label", () => {
    expect(flagLabel("high")).toBe("High");
    expect(flagLabel("low")).toBe("Low");
    expect(flagLabel("abnormal")).toBe("Abnormal");
    expect(flagLabel("non-optimal-high")).toBe("Above optimal");
    expect(flagLabel("non-optimal-low")).toBe("Below optimal");
    expect(flagLabel("non-optimal")).toBe("Non-optimal");
    expect(flagLabel("normal")).toBe("Normal");
    expect(flagLabel("immune")).toBe("Immune");
  });

  // The bug the issue reports: the two former copies disagreed on the catch-all
  // (attention.ts → "Non-optimal", RecentLabsWidget → "Normal"). The unified map
  // uses the tone-consistent "Normal" — we never label an unflagged/unknown value
  // as a mild "Non-optimal" false alarm.
  it("uses one deliberate 'Normal' fallback for unknown/absent flags", () => {
    expect(flagLabel(null)).toBe("Normal");
    expect(flagLabel(undefined)).toBe("Normal");
    expect(flagLabel("brand-new-flag")).toBe("Normal");
  });

  it("never labels a default-tone flag as an abnormal/non-optimal word", () => {
    // A "default" tone must not read as a concern label — the fallback stays
    // consistent with flagTone so surfaces can't disagree.
    for (const f of [null, undefined, "normal", "mystery"]) {
      if (flagTone(f) === "default") {
        expect(flagLabel(f)).toBe("Normal");
      }
    }
  });
});
