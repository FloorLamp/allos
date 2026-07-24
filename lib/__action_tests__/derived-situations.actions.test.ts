// SERVER-ACTION TIER — the poor-sleep derived-context override (#1292).
//
// dismissDerivedPoorSleep writes a date-scoped suppression row under the registered
// poor-sleep-override prefix; keying an item to a derived situation is an ordinary
// situational item write. These drive the real action against the throwaway temp DB
// and assert: the override is profile-scoped, date-scoped, and INDEPENDENT of a
// declared toggle (a declared Poor sleep survives the override).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  dismissDerivedPoorSleep,
  toggleSituation,
} from "@/app/(app)/nutrition/supplement-actions";
import { getActiveSituations } from "@/lib/settings";
import { poorSleepOverrideKey } from "@/lib/derived-situations";
import { seedActor, actAs, createLogin, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function overrideKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'poor-sleep-override:%' ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

describe("dismissDerivedPoorSleep — the 'Not today' override", () => {
  it("writes today's date-scoped override row, profile-scoped, and revalidates", async () => {
    const { profile } = seedActor({ profileName: "OverrideActor" });
    const res = await dismissDerivedPoorSleep();
    expect(res.ok).toBe(true);
    expect(overrideKeys(profile.id)).toEqual([
      poorSleepOverrideKey(today(profile.id)),
    ]);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("stays scoped to the acting profile (no cross-profile write)", async () => {
    const login = createLogin({ role: "admin" });
    const a = createProfile("A", login.id);
    const b = createProfile("B", login.id);

    actAs(login, a);
    await dismissDerivedPoorSleep();

    expect(overrideKeys(a.id)).toHaveLength(1);
    expect(overrideKeys(b.id)).toHaveLength(0);
  });

  it("is INDEPENDENT of the declared toggle: a declared Poor sleep survives the override", async () => {
    const { profile } = seedActor({ profileName: "IndependentActor" });
    // Declare Poor sleep via the normal chip path.
    await toggleSituation(fd({ situation: "Poor sleep" }));
    expect(getActiveSituations(profile.id)).toContain("Poor sleep");

    // The override writes a separate suppression row — it does NOT clear the declared
    // situation (the chip owns that lifecycle; the override only touches the derived
    // contribution).
    await dismissDerivedPoorSleep();
    expect(getActiveSituations(profile.id)).toContain("Poor sleep");
    expect(overrideKeys(profile.id)).toHaveLength(1);
  });
});
