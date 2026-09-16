// SERVER-ACTION TIER — the log sheet's open-time gather (issue #2651), and the one
// field on it that renders nothing: `slotBoundaries` (#5902).
//
// The sheet closes on a resume that crossed a food-window boundary, and the window
// it opened in has to come from somewhere. This gather already runs on every open
// and the app shell holds no boundaries of its own, so the splits ride back with
// the offers rather than earning a read of their own. What matters here is that
// they are the PROFILE's — `profileFoodSlotBoundaries`, the same derivation every
// food reader and writer uses, so the sheet's idea of "still Morning" cannot
// disagree with the window a tap would be filed under.

import { describe, it, expect } from "vitest";
import { setProfileSetting } from "@/lib/settings";
import { loadLogSheetContext } from "@/app/(app)/log-sheet-actions";
import {
  DEFAULT_EVENING_BOUNDARY_MIN,
  DEFAULT_MIDDAY_BOUNDARY_MIN,
} from "@/lib/food-slot";
import { createLogin, createProfile, actAs } from "./harness";

function signedIn(access: "read" | "write" = "write") {
  const login = createLogin();
  const profile = createProfile("Slot reader", login.id);
  actAs(login, profile, access);
  return profile;
}

describe("loadLogSheetContext carries the profile's food-window splits", () => {
  it("returns the fixed defaults for an unconfigured schedule", async () => {
    signedIn();
    const context = await loadLogSheetContext();
    expect(context.slotBoundaries).toEqual({
      midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
      evening: DEFAULT_EVENING_BOUNDARY_MIN,
    });
  });

  it("re-anchors on a fully configured schedule, at the same midpoints the ledger uses", async () => {
    const profile = signedIn();
    setProfileSetting(profile.id, "notify_supp_morning_hour", "09:00");
    setProfileSetting(profile.id, "notify_supp_midday_hour", "13:00");
    setProfileSetting(profile.id, "notify_supp_evening_hour", "19:00");
    const context = await loadLogSheetContext();
    expect(context.slotBoundaries).toEqual({
      midday: 11 * 60,
      evening: 16 * 60,
    });
  });

  it("still carries them for read-only access, which renders no offer at all", async () => {
    signedIn("read");
    const context = await loadLogSheetContext();
    expect(context.routine).toBeNull();
    expect(context.slotBoundaries).toEqual({
      midday: DEFAULT_MIDDAY_BOUNDARY_MIN,
      evening: DEFAULT_EVENING_BOUNDARY_MIN,
    });
  });
});
