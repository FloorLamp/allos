import { describe, expect, it } from "vitest";
import {
  EPISODE_REOPEN_WINDOW_DAYS,
  episodeReopenEligibility,
} from "@/lib/illness-episode-reopen";

describe("episodeReopenEligibility", () => {
  it("allows a resolved episode for seven days after its last included day", () => {
    expect(episodeReopenEligibility("2026-07-18", "2026-07-17")).toEqual({
      kind: "eligible",
      elapsedDays: 0,
    });
    expect(episodeReopenEligibility("2026-07-18", "2026-07-24")).toEqual({
      kind: "eligible",
      elapsedDays: EPISODE_REOPEN_WINDOW_DAYS,
    });
  });

  it("expires after the relapse window", () => {
    expect(episodeReopenEligibility("2026-07-18", "2026-07-25")).toEqual({
      kind: "expired",
    });
  });

  it("does not offer reopen for ongoing or invalid ranges", () => {
    expect(episodeReopenEligibility(null, "2026-07-17")).toEqual({
      kind: "ongoing",
    });
    expect(episodeReopenEligibility("2026-07-19", "2026-07-17")).toEqual({
      kind: "invalid",
    });
  });
});
