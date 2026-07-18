// SERVER-ACTION TIER — the kind × channel matrix columns (#928). Each column saves
// through a tier-correct action: Telegram + Home Assistant follow the PROFILE
// (requireWriteAccess), Web Push follows the LOGIN (requireSession, login-scoped).
// Proves each persists to its own tier store, the HA column preserves the channel's
// enable/URL, and the profile-tier columns refuse a read-only member.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  saveTelegramNotifyKinds,
  saveHomeAssistantNotifyKinds,
} from "@/app/(app)/settings/profile/actions";
import { savePushNotifyKinds } from "@/app/(app)/settings/actions";
import {
  getProfileTelegramDisabledKinds,
  getLoginPushDisabledKinds,
  getProfileHomeAssistant,
  setProfileHomeAssistant,
} from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

const disabled = (kinds: string[]) => ({
  disabled_kinds: JSON.stringify(kinds),
});

beforeEach(() => revalidate.mockClear());

describe("saveTelegramNotifyKinds (profile tier)", () => {
  it("persists the Telegram column to the acting profile", async () => {
    const login = createLogin();
    const profile = createProfile("tg-owner", login.id);
    const bystander = createProfile("bystander", login.id);
    actAs(login, profile);

    const res = await saveTelegramNotifyKinds(
      fd(disabled(["refill", "digest"]))
    );
    expect(res).toEqual({ ok: true });
    expect(new Set(getProfileTelegramDisabledKinds(profile.id))).toEqual(
      new Set(["refill", "digest"])
    );
    // Profile-scoped: a bystander profile is untouched.
    expect(getProfileTelegramDisabledKinds(bystander.id)).toEqual([]);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("drops unknown kinds via the shared pure parser", async () => {
    const login = createLogin();
    const profile = createProfile("tg-parse", login.id);
    actAs(login, profile);
    await saveTelegramNotifyKinds(fd(disabled(["refill", "not-a-kind"])));
    expect(getProfileTelegramDisabledKinds(profile.id)).toEqual(["refill"]);
  });

  it("refuses a read-only member (requireWriteAccess gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("tg-ro", login.id);
    actAs(login, profile, "read");
    await expect(
      saveTelegramNotifyKinds(fd(disabled(["refill"])))
    ).rejects.toThrow(/read-only/);
    expect(getProfileTelegramDisabledKinds(profile.id)).toEqual([]);
  });
});

describe("saveHomeAssistantNotifyKinds (profile tier)", () => {
  it("rewrites only the disabled kinds, preserving enable/URL/secret", async () => {
    const login = createLogin();
    const profile = createProfile("ha-kinds", login.id);
    actAs(login, profile);
    setProfileHomeAssistant(profile.id, {
      enabled: true,
      webhookUrl: "http://homeassistant.local:8123/api/webhook/allos-x",
      secret: "keep",
      disabledKinds: ["digest"],
    });

    await saveHomeAssistantNotifyKinds(fd(disabled(["refill"])));
    const cfg = getProfileHomeAssistant(profile.id);
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookUrl).toBe(
      "http://homeassistant.local:8123/api/webhook/allos-x"
    );
    expect(cfg.secret).toBe("keep");
    expect(cfg.disabledKinds).toEqual(["refill"]);
  });
});

describe("savePushNotifyKinds (login tier)", () => {
  it("persists the push column to the acting login, not the profile", async () => {
    const login = createLogin();
    const profile = createProfile("push-owner", login.id);
    actAs(login, profile);

    const res = await savePushNotifyKinds(fd(disabled(["milestone"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginPushDisabledKinds(login.id)).toEqual(["milestone"]);
    // Login-scoped: NOT written to the profile's telegram column.
    expect(getProfileTelegramDisabledKinds(profile.id)).toEqual([]);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("is allowed for a read-only member (login-scoped, not profile-owned)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("push-ro", login.id);
    actAs(login, profile, "read");
    // requireSession() only — a read-only member may still set their own push prefs.
    const res = await savePushNotifyKinds(fd(disabled(["refill"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginPushDisabledKinds(login.id)).toEqual(["refill"]);
  });
});
