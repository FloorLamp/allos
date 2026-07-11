// SERVER-ACTION TIER — AI insight generation (sidebar consolidation).
//
// generateForDate (Trends "Insights" tab) writes an AI daily insight for the
// active profile. The tab — and its generate form — is spliced out of the UI for
// age-restricted profiles, so the action re-checks isTrainingRestricted() on the
// write path and bounces (redirect "/") BEFORE doing any AI work. These tests
// assert that guard: a restricted profile is rejected with no insight written,
// while an eligible profile still gets one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { generateForDate } from "@/app/(app)/trends/actions";
import { getInsight } from "@/lib/queries";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
  // Default: gate off. Individual tests turn it on.
  setMinTrainingAge(null);
});

describe("generateForDate age-gate guard", () => {
  it("rejects an age-restricted profile without writing an insight", async () => {
    const { profile } = seedActor();
    // Turn the instance gate on and make this profile under-age.
    setMinTrainingAge(18);
    setStoredAge(profile.id, 10);

    // redirect() throws (NEXT_REDIRECT) — the action must bounce before any AI
    // work or DB write happens.
    await expect(generateForDate(fd({ date: "2026-07-01" }))).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(getInsight(profile.id, "2026-07-01")).toBeUndefined();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("generates an insight for an eligible profile (gate off)", async () => {
    const { profile } = seedActor();
    // Gate off by default (beforeEach) — even a young stored age is unrestricted.
    setStoredAge(profile.id, 10);

    await generateForDate(fd({ date: "2026-07-01" }));

    const insight = getInsight(profile.id, "2026-07-01");
    expect(insight).toBeDefined();
    expect(insight?.date).toBe("2026-07-01");
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });
});

// Issue #411: the persisted offline insight must state the REAL reason it ran. With
// no key configured, that's the honest "set ANTHROPIC_API_KEY" note + a distinct
// "offline/no-key" model tag — never a lie, and never collapsed into one opaque
// "offline-fallback" the list view can't distinguish.
describe("generateForDate offline-reason honesty (#411)", () => {
  let savedKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    // Force the deterministic no-key path regardless of the CI environment.
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBaseUrl = process.env.AI_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_BASE_URL;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedBaseUrl === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = savedBaseUrl;
  });

  it("tags the no-key fallback honestly and states the real reason", async () => {
    const { profile } = seedActor();

    await generateForDate(fd({ date: "2026-07-02" }));

    const insight = getInsight(profile.id, "2026-07-02");
    expect(insight?.model).toBe("offline/no-key");
    expect(insight?.summary).toContain("set ANTHROPIC_API_KEY");
    // Honesty invariant: the "set a key" line only ever appears on the no-key tag.
    expect(insight?.summary).not.toContain("daily AI limit reached");
    expect(insight?.summary).not.toContain("temporarily unavailable");
  });
});
