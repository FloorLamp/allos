// SERVER-ACTION TIER — dashboard layout persistence (#156).
//
// saveDashboardLayout takes plain args (not FormData) and persists the order/hidden
// blob under the ACTIVE profile's profile_settings. Asserts the stored JSON and the
// round-trip through getDashboardLayout, plus per-profile scoping.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveDashboardLayout } from "@/app/(app)/actions";
import { getDashboardLayout, getProfileSetting } from "@/lib/settings";
import { seedActor, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

describe("saveDashboardLayout", () => {
  it("persists the layout blob under the acting profile and revalidates", async () => {
    const { profile } = seedActor();

    await saveDashboardLayout(["weight", "goals", "supplements"], ["insights"]);

    const layout = getDashboardLayout(profile.id);
    expect(layout).toEqual({
      order: ["weight", "goals", "supplements"],
      hidden: ["insights"],
    });
    // Stored as a JSON string in profile_settings under the dashboard_layout key.
    const raw = getProfileSetting(profile.id, "dashboard_layout");
    expect(raw && JSON.parse(raw)).toEqual(layout);
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("dedupes/trims ids on write", async () => {
    const { profile } = seedActor();
    await saveDashboardLayout(
      [" weight ", "weight", "goals"],
      ["", "insights"]
    );
    expect(getDashboardLayout(profile.id)).toEqual({
      order: ["weight", "goals"],
      hidden: ["insights"],
    });
  });

  it("is scoped to the acting profile", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("DashB", login.id);

    actAs(login, profileA);
    await saveDashboardLayout(["weight"], []);

    expect(getDashboardLayout(profileA.id)).toEqual({
      order: ["weight"],
      hidden: [],
    });
    expect(getDashboardLayout(profileB.id)).toBeNull();
  });
});
