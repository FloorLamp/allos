// SERVER-ACTION TIER — the free-days write path (issue #1241) through the real
// saveFreeDays action + the (mocked) auth guard. Proves the per-profile off-day set
// round-trips (sorted, de-duped, junk-dropped), that an explicit empty submission is
// honored as "no free days" (distinct from the unset Sat/Sun default), and that the
// write revalidates. The predicate swap it drives is pinned in the pure
// sleep-regularity suite.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { revalidatePath } from "next/cache";
import { saveFreeDays } from "@/app/(app)/settings/profile/actions";
import { getFreeDays } from "@/lib/settings";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// FormData with a multi-value "free_days" field (one value per checked weekday box).
function freeDaysForm(days: number[]): FormData {
  const form = new FormData();
  for (const d of days) form.append("free_days", String(d));
  return form;
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveFreeDays", () => {
  it("defaults to Sat/Sun when never set", () => {
    const login = createLogin();
    const profile = createProfile("free-default", login.id);
    actAs(login, profile);
    expect(getFreeDays(profile.id)).toEqual([0, 6]);
  });

  it("round-trips the off-day set (sorted, de-duped) and revalidates", async () => {
    const login = createLogin();
    const profile = createProfile("free-set", login.id);
    actAs(login, profile);

    await saveFreeDays(freeDaysForm([4, 3, 3])); // Wed/Thu, dup dropped, sorted
    expect(getFreeDays(profile.id)).toEqual([3, 4]);
    expect(revalidate).toHaveBeenCalledWith("/settings/profile");
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("drops out-of-range values (a forged post can't store junk)", async () => {
    const login = createLogin();
    const profile = createProfile("free-junk", login.id);
    actAs(login, profile);

    await saveFreeDays(freeDaysForm([1, 7, -1, 5]));
    expect(getFreeDays(profile.id)).toEqual([1, 5]);
  });

  it("an explicit empty submission is honored as 'no free days' (not the default)", async () => {
    const login = createLogin();
    const profile = createProfile("free-empty", login.id);
    actAs(login, profile);

    await saveFreeDays(freeDaysForm([2]));
    expect(getFreeDays(profile.id)).toEqual([2]);
    // Clearing all boxes stores an explicit empty set — NOT a fallback to Sat/Sun.
    await saveFreeDays(freeDaysForm([]));
    expect(getFreeDays(profile.id)).toEqual([]);
  });

  it("persists to profile_settings under the profile's own row", async () => {
    const login = createLogin();
    const profile = createProfile("free-scope", login.id);
    actAs(login, profile);

    await saveFreeDays(freeDaysForm([1, 2, 3, 4, 5]));
    const row = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'free_days'"
      )
      .get(profile.id) as { value: string } | undefined;
    expect(row?.value).toBe("1,2,3,4,5");
  });
});
