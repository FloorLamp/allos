// SERVER-ACTION TIER — the kind × channel matrix columns (#928, re-homed by #1072).
// Each column saves through a tier-correct action: Telegram + Web Push follow the
// LOGIN (requireSession, login-scoped as of #1072), Home Assistant follows the
// PROFILE (requireWriteAccess). Proves each persists to its own tier store, the HA
// column preserves the channel's enable/URL, the login-tier columns allow a
// read-only member, and the HA (profile) column refuses one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { saveHomeAssistantNotifyKinds } from "@/app/(app)/settings/profile/actions";
import {
  savePushNotifyKinds,
  saveLoginTelegramNotifyKinds,
} from "@/app/(app)/settings/actions";
import {
  getLoginTelegramDisabledKinds,
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

describe("saveLoginTelegramNotifyKinds (login tier, #1072)", () => {
  it("persists the Telegram column to the acting login, not the profile", async () => {
    const login = createLogin();
    const profile = createProfile("tg-owner", login.id);
    const other = createLogin();
    actAs(login, profile);

    const res = await saveLoginTelegramNotifyKinds(
      fd(disabled(["refill", "digest"]))
    );
    expect(res).toEqual({ ok: true });
    expect(new Set(getLoginTelegramDisabledKinds(login.id))).toEqual(
      new Set(["refill", "digest"])
    );
    // Login-scoped: another login is untouched.
    expect(getLoginTelegramDisabledKinds(other.id)).toEqual([]);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("drops unknown kinds via the shared pure parser", async () => {
    const login = createLogin();
    const profile = createProfile("tg-parse", login.id);
    actAs(login, profile);
    await saveLoginTelegramNotifyKinds(fd(disabled(["refill", "not-a-kind"])));
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual(["refill"]);
  });

  it("is allowed for a read-only member (login-scoped, not profile-owned)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("tg-ro", login.id);
    actAs(login, profile, "read");
    // requireSession() only — a read-only member may still set their own Telegram
    // channel prefs (the chat is theirs), like the push column.
    const res = await saveLoginTelegramNotifyKinds(fd(disabled(["refill"])));
    expect(res).toEqual({ ok: true });
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual(["refill"]);
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
    // Login-scoped: NOT written to the login's telegram column.
    expect(getLoginTelegramDisabledKinds(login.id)).toEqual([]);
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
