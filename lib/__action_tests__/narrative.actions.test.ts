// SERVER-ACTION TIER — AI narrative generation (issue #20).
//
// generateRecap (Trends "Insights" tab) writes a weekly/monthly AI recap
// narrative for the active profile; like the daily insight it's age-gated, so the
// action re-checks isTrainingRestricted() and bounces BEFORE any AI work.
// generateLabTrend (Biomarkers tab) writes a lab-trend interpretation and is NOT
// age-gated. With no ANTHROPIC_API_KEY these store the deterministic OFFLINE
// composition (model "offline-fallback"), so the tests run without network.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { generateRecap, generateLabTrend } from "@/app/(app)/trends/actions";
import { getRecentNarratives } from "@/lib/queries";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
  setMinTrainingAge(null);
});

describe("generateRecap age-gate guard", () => {
  it("rejects an age-restricted profile without writing a narrative", async () => {
    const { profile } = seedActor();
    setMinTrainingAge(18);
    setStoredAge(profile.id, 10);

    await expect(generateRecap(fd({ period: "week" }))).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(getRecentNarratives(profile.id, ["week"], 5)).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("stores a weekly recap for an eligible profile (offline fallback)", async () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, 30);

    await generateRecap(fd({ period: "week" }));

    const [narrative] = getRecentNarratives(profile.id, ["week"], 5);
    expect(narrative).toBeDefined();
    expect(narrative.kind).toBe("week");
    expect(narrative.model).toBe("offline-fallback");
    expect(narrative.summary.length).toBeGreaterThan(0);
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("defaults an unknown period to weekly", async () => {
    const { profile } = seedActor();
    await generateRecap(fd({ period: "quarterly" }));
    expect(getRecentNarratives(profile.id, ["week"], 5)).toHaveLength(1);
    expect(getRecentNarratives(profile.id, ["month"], 5)).toHaveLength(0);
  });
});

describe("generateLabTrend", () => {
  it("stores a lab-trend interpretation (not age-gated, offline fallback)", async () => {
    const { profile } = seedActor();
    // Even an age-restricted profile can read lab trends (Biomarkers is not gated).
    setMinTrainingAge(18);
    setStoredAge(profile.id, 10);

    await generateLabTrend();

    const [narrative] = getRecentNarratives(profile.id, ["labs"], 5);
    expect(narrative).toBeDefined();
    expect(narrative.kind).toBe("labs");
    expect(narrative.model).toBe("offline-fallback");
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });
});
