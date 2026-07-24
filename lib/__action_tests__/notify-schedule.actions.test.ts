// SERVER-ACTION TIER — wake-aware mornings (#1117). Proves saveNotificationPrefs
// records the "auto" INTENT for the Morning slot + digest (not a round-tripped
// number, which would pollute the "absent = auto" read-resolution), persists a
// manual pick as a number, and toggles the sleep-summary opt-in.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveNotificationPrefs } from "@/app/(app)/settings/profile/actions";
import {
  getNotifySchedule,
  getProfileSetting,
  getProfileSleepDigest,
} from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// A full notification-prefs form with the schedule fields under test overridable.
const prefsForm = (over: Record<string, string>) =>
  fd({
    telegram_enabled: "1",
    telegram_chat_id: "123",
    supp_morning_hour: "",
    supp_midday_hour: "13",
    supp_evening_hour: "20",
    supp_bedtime_hour: "22",
    workout_enabled: "1",
    digest_hour: "",
    recap_day: "",
    recap_hour: "9",
    milestones_enabled: "1",
    preventive_enabled: "1",
    waking_start_hour: "8",
    waking_end_hour: "21",
    ...over,
  });

describe("saveNotificationPrefs — wake-aware fields (#1117)", () => {
  it("records the 'auto' sentinel for the Morning slot, not a number", async () => {
    const login = createLogin();
    const profile = createProfile("auto-morning", login.id);
    actAs(login, profile);

    await saveNotificationPrefs(prefsForm({ supp_morning_hour: "auto" }));

    expect(getProfileSetting(profile.id, "notify_supp_morning_hour")).toBe(
      "auto"
    );
    expect(getNotifySchedule(profile.id).morningAuto).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/settings/profile");
  });

  it("persists a manual Morning hour as a number (auto off)", async () => {
    const login = createLogin();
    const profile = createProfile("manual-morning", login.id);
    actAs(login, profile);

    await saveNotificationPrefs(prefsForm({ supp_morning_hour: "9" }));

    expect(getProfileSetting(profile.id, "notify_supp_morning_hour")).toBe("9");
    const sched = getNotifySchedule(profile.id);
    expect(sched.morningAuto).toBe(false);
    expect(sched.supplementHours.Morning).toBe(9);
  });

  it("records 'auto' for the digest, turning it on at the wake hour", async () => {
    const login = createLogin();
    const profile = createProfile("auto-digest", login.id);
    actAs(login, profile);

    await saveNotificationPrefs(prefsForm({ digest_hour: "auto" }));

    expect(getProfileSetting(profile.id, "notify_digest_hour")).toBe("auto");
    expect(getNotifySchedule(profile.id).digestAuto).toBe(true);
  });

  it("keeps the digest off when 'off' is chosen", async () => {
    const login = createLogin();
    const profile = createProfile("off-digest", login.id);
    actAs(login, profile);

    await saveNotificationPrefs(prefsForm({ digest_hour: "" }));

    expect(getProfileSetting(profile.id, "notify_digest_hour")).toBe("");
    const sched = getNotifySchedule(profile.id);
    expect(sched.digestAuto).toBe(false);
    expect(sched.digestHour).toBeNull();
  });

  it("sleep summary is ON by default (#1378) and the toggle is an opt-OUT", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-optout", login.id);
    actAs(login, profile);

    // #1378: absent key means on — a fresh profile gets the sleep section by default.
    expect(getProfileSleepDigest(profile.id)).toBe(true);
    // Opting out stores "0" and turns it off.
    await saveNotificationPrefs(prefsForm({ digest_sleep_enabled: "0" }));
    expect(getProfileSleepDigest(profile.id)).toBe(false);
    // Opting back in stores "1" and turns it on.
    await saveNotificationPrefs(prefsForm({ digest_sleep_enabled: "1" }));
    expect(getProfileSleepDigest(profile.id)).toBe(true);
  });
});
