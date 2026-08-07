import { describe, expect, it } from "vitest";
import { dedupeProtocolAdherenceLabel } from "@/lib/protocol-practice";

describe("dedupeProtocolAdherenceLabel", () => {
  it("drops a repeated protocol-name prefix", () => {
    expect(
      dedupeProtocolAdherenceLabel(
        "Red light therapy",
        "Red light therapy sessions"
      )
    ).toBe("Sessions");
  });

  it("drops a shared leading phrase and preserves unrelated labels", () => {
    expect(
      dedupeProtocolAdherenceLabel("Strength baseline", "Strength sessions")
    ).toBe("Sessions");
    expect(dedupeProtocolAdherenceLabel("Sleep trial", "Sauna sessions")).toBe(
      "Sauna sessions"
    );
  });
});
