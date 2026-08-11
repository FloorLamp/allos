// SERVER-ACTION TIER — AI period-recap generation (issue #20).
//
// generateRecap (Trends "Insights" tab) writes a weekly/monthly AI recap
// period recap for the active profile; like the daily insight it's age-gated, so the
// action re-checks isTrainingRestricted() and bounces BEFORE any AI work. With no
// ANTHROPIC_API_KEY it stores the deterministic OFFLINE composition (model
// "offline-fallback"), so the tests run without network. (The lab-trend generator
// was removed with the Trends → Biomarkers tab — #1164.)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { generateRecap } from "@/app/(app)/trends/actions";
import { getRecentPeriodRecaps } from "@/lib/queries";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
  setMinTrainingAge(null);
});

describe("generateRecap age-gate guard", () => {
  it("rejects an age-restricted profile without writing a period recap", async () => {
    const { profile } = seedActor();
    setMinTrainingAge(18);
    setStoredAge(profile.id, 10);

    await expect(generateRecap(fd({ period: "week" }))).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(getRecentPeriodRecaps(profile.id, ["week"], 5)).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("stores a weekly recap for an eligible profile (offline fallback)", async () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, 30);

    await generateRecap(fd({ period: "week" }));

    const [periodRecap] = getRecentPeriodRecaps(profile.id, ["week"], 5);
    expect(periodRecap).toBeDefined();
    expect(periodRecap.kind).toBe("week");
    expect(periodRecap.model).toBe("offline-fallback");
    expect(periodRecap.summary.length).toBeGreaterThan(0);
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("defaults an unknown period to weekly", async () => {
    const { profile } = seedActor();
    await generateRecap(fd({ period: "quarterly" }));
    expect(getRecentPeriodRecaps(profile.id, ["week"], 5)).toHaveLength(1);
    expect(getRecentPeriodRecaps(profile.id, ["month"], 5)).toHaveLength(0);
  });
});
