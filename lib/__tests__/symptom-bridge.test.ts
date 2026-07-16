import { describe, it, expect } from "vitest";
import {
  isBuiltInIllnessSituation,
  suggestIllnessActivation,
  BUILTIN_ILLNESS_SITUATION,
} from "@/lib/situations";

// Pure tests for the #799 illness-type defaults + the symptom→situation bridge (the
// suggest-only, never-auto discipline mirrored from #560).

describe("isBuiltInIllnessSituation", () => {
  it("matches the built-in Illness case/whitespace-folded", () => {
    expect(isBuiltInIllnessSituation("Illness")).toBe(true);
    expect(isBuiltInIllnessSituation("illness")).toBe(true);
    expect(isBuiltInIllnessSituation("  Illness ")).toBe(true);
    expect(BUILTIN_ILLNESS_SITUATION).toBe("Illness");
  });

  it("does NOT match other situations — they opt in explicitly", () => {
    expect(isBuiltInIllnessSituation("Injury")).toBe(false);
    expect(isBuiltInIllnessSituation("Travel")).toBe(false);
    expect(isBuiltInIllnessSituation("Migraine")).toBe(false);
    expect(isBuiltInIllnessSituation("High stress")).toBe(false);
  });
});

describe("suggestIllnessActivation (bridge direction A)", () => {
  it("suggests activating Illness when no illness-type situation is active", () => {
    expect(suggestIllnessActivation(false)).toBe("Illness");
  });

  it("suggests nothing when an illness-type situation is already active (the card shows)", () => {
    expect(suggestIllnessActivation(true)).toBeNull();
  });
});
