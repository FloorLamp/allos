import { describe, expect, it } from "vitest";
import {
  decidePeriodontalObservation,
  periodontalObservationKey,
  ORAL_HEALTH_PREFIX,
} from "@/lib/oral-health-observation";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

// The pure diabetes↔periodontitis coaching observation (issue #706, ask 4).

describe("decidePeriodontalObservation", () => {
  it("emits the calm note for a profile with active diabetes", () => {
    const obs = decidePeriodontalObservation({ hasDiabetes: true });
    expect(obs).not.toBeNull();
    expect(obs!.dedupeKey).toBe(periodontalObservationKey());
    expect(obs!.title).toContain("Gum health");
    // Observational + bidirectional framing, prescribes nothing clinical.
    expect(obs!.detail.toLowerCase()).toContain("both directions");
  });

  it("emits nothing without diabetes", () => {
    expect(decidePeriodontalObservation({ hasDiabetes: false })).toBeNull();
  });

  it("keys under the registered, guardable prefix", () => {
    expect(periodontalObservationKey().startsWith(ORAL_HEALTH_PREFIX)).toBe(
      true
    );
    // The suppression-bus prefix guard recognizes it (so a dismiss action matches).
    expect(dedupeKeyHasKnownPrefix(periodontalObservationKey())).toBe(true);
  });
});
