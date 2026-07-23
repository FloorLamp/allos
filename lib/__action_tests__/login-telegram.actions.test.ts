// SERVER-ACTION TIER — the login-scoped Telegram channel + per-profile mute (issue
// #1072). Proves the channel enable/chat id round-trips to login_settings (not the
// profile), a read-only member may still set their OWN channel (login-scoped gate),
// the mute is per-(login, profile) and rejects a profile outside the caller's access,
// and saving clears the post-migration review flag.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  saveLoginTelegram,
  saveProfileNotifyMute,
} from "@/app/(app)/settings/actions";
import {
  getLoginTelegram,
  isProfileMutedForLogin,
  getNotifyReviewNeeded,
  setNotifyReviewNeeded,
  getProfileSetting,
} from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

describe("saveLoginTelegram (login tier)", () => {
  it("persists the channel to the acting login, not the profile", async () => {
    const login = createLogin();
    const profile = createProfile("lt-owner", login.id);
    actAs(login, profile);

    const res = await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "5550123" })
    );
    expect(res).toEqual({ ok: true });
    const chan = getLoginTelegram(login.id);
    expect(chan.telegramEnabled).toBe(true);
    expect(chan.telegramChatId).toBe("5550123");
    // NOT written to the profile tier.
    expect(getProfileSetting(profile.id, "telegram_chat_id")).toBeUndefined();
  });

  it("is allowed for a read-only member (the chat is theirs)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("lt-ro", login.id);
    actAs(login, profile, "read");
    const res = await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "5550777" })
    );
    expect(res).toEqual({ ok: true });
    expect(getLoginTelegram(login.id).telegramChatId).toBe("5550777");
  });

  it("clears the post-migration review flag on save", async () => {
    const login = createLogin();
    const profile = createProfile("lt-review", login.id);
    actAs(login, profile);
    setNotifyReviewNeeded(login.id);
    expect(getNotifyReviewNeeded(login.id)).toBe(true);

    await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "5550001" })
    );
    expect(getNotifyReviewNeeded(login.id)).toBe(false);
  });
});

describe("saveProfileNotifyMute (login tier)", () => {
  it("mutes a profile for the caller's login only", async () => {
    const login = createLogin();
    const profile = createProfile("mute-target", login.id);
    actAs(login, profile);

    const res = await saveProfileNotifyMute(
      fd({ profile_id: String(profile.id), muted: "1" })
    );
    expect(res).toEqual({ ok: true });
    expect(isProfileMutedForLogin(login.id, profile.id)).toBe(true);

    // Un-mute.
    await saveProfileNotifyMute(
      fd({ profile_id: String(profile.id), muted: "0" })
    );
    expect(isProfileMutedForLogin(login.id, profile.id)).toBe(false);
  });

  it("refuses to mute a profile outside the caller's access (forged id)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("mute-own", login.id);
    // A second profile the member is NOT granted.
    const foreign = createProfile("mute-foreign");
    actAs(login, profile);

    const res = await saveProfileNotifyMute(
      fd({ profile_id: String(foreign.id), muted: "1" })
    );
    expect(res).toEqual({ ok: false });
    expect(isProfileMutedForLogin(login.id, foreign.id)).toBe(false);
  });
});
