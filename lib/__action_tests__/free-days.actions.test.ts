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
  it("defaults, normalizes, persists, revalidates, and explicitly clears", async () => {
    const login = createLogin();
    const profile = createProfile("free-lifecycle", login.id);
    actAs(login, profile);

    expect(getFreeDays(profile.id)).toEqual([0, 6]);

    // Sort, de-duplicate, and discard forged out-of-range values.
    await saveFreeDays(freeDaysForm([5, 1, 7, -1, 3, 2, 4, 1]));
    expect(getFreeDays(profile.id)).toEqual([1, 2, 3, 4, 5]);
    expect(revalidate).toHaveBeenCalledWith("/settings/health");
    expect(revalidate).toHaveBeenCalledWith("/trends");

    const row = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'free_days'"
      )
      .get(profile.id) as { value: string } | undefined;
    expect(row?.value).toBe("1,2,3,4,5");

    // Clearing all boxes stores an explicit empty set — NOT a fallback to Sat/Sun.
    await saveFreeDays(freeDaysForm([]));
    expect(getFreeDays(profile.id)).toEqual([]);
  });
});
