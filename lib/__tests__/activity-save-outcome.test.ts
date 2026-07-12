import { describe, it, expect } from "vitest";
import { saveOutcomeMessage } from "@/lib/activity-save-outcome";

// PURE TIER — the failure-message mapping for saveActivity's typed outcome (#332).
describe("saveOutcomeMessage", () => {
  it("names the profile mismatch for a not-owned failure", () => {
    const msg = saveOutcomeMessage("not-owned");
    expect(msg).toMatch(/couldn.t save/i);
    expect(msg).toMatch(/active profile/i);
  });

  it("points at title/date for an invalid failure", () => {
    const msg = saveOutcomeMessage("invalid");
    expect(msg).toMatch(/couldn.t save/i);
    expect(msg).toMatch(/title|date/i);
  });

  it("explains the training restriction for a restricted failure (#488)", () => {
    const msg = saveOutcomeMessage("restricted");
    expect(msg).toMatch(/couldn.t save/i);
    expect(msg).toMatch(/available|profile/i);
  });

  it("never reports a failure as saved", () => {
    for (const reason of ["not-owned", "invalid", "restricted"] as const) {
      expect(saveOutcomeMessage(reason).toLowerCase()).not.toContain("saved");
    }
  });
});
