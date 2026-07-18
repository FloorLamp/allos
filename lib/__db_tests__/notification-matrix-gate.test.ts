// DB INTEGRATION TIER — the kind × channel matrix ENFORCEMENT at each channel's
// dispatch seam (#928). Proves what the pure gate can't: a kind a user disabled for
// a channel is a DELIBERATE non-send at that channel's send site — no throw, so
// dispatch() counts the channel healthy and never sets notify_last_error. Covers the
// two new columns: Telegram (profile-scoped, gated inside the chokepoint) and Web
// Push (login-scoped, gated per-subscription by its owning login).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  setSetting,
  setProfileTelegram,
  setProfileTelegramDisabledKinds,
  setLoginPushDisabledKinds,
} from "@/lib/settings";
import {
  ensureVapidKeys,
  savePushSubscription,
} from "@/lib/notifications/push";
import { dispatch, getNotifyError } from "@/lib/notifications";
import type { NotificationMessage } from "@/lib/notifications/types";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newLogin(role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`u${Math.random().toString(36).slice(2)}`, role).lastInsertRowid
  );
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(loginId, profileId);
}

const REFILL: NotificationMessage = {
  title: "Refill soon",
  body: "Vitamin D is running low",
  kind: "refill",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A Telegram send hits fetch — mock a valid Telegram OK so an ENABLED kind would
  // succeed (proving a DISABLED kind never even reaches fetch).
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});

afterEach(() => vi.unstubAllGlobals());

describe("Telegram column gate (chokepoint)", () => {
  it("a disabled kind is a silent non-send — no fetch, no marker", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tg-gate");
    setProfileTelegram(p, { telegramEnabled: true, telegramChatId: "123" });
    setProfileTelegramDisabledKinds(p, ["refill"]);

    const results = await dispatch(p, REFILL);
    // Telegram is the only configured channel; the send short-circuited.
    expect(results).toEqual([{ id: "telegram", ok: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getNotifyError()).toBeNull();
  });

  it("an enabled kind DOES reach the Telegram send site", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tg-enabled");
    setProfileTelegram(p, { telegramEnabled: true, telegramChatId: "123" });
    setProfileTelegramDisabledKinds(p, ["digest"]); // refill still on

    const results = await dispatch(p, REFILL);
    expect(results).toEqual([{ id: "telegram", ok: true }]);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("Web Push column gate (per owning login)", () => {
  it("filters out a subscription whose login disabled the kind — no marker", async () => {
    ensureVapidKeys();
    const p = newProfile("push-gate");
    const member = newLogin("member");
    grant(member, p);
    // A real-looking but unreachable endpoint: if the gate FAILED to filter it, the
    // web-push send would error and set the marker — so ok + null marker proves the
    // filter ran.
    savePushSubscription(member, {
      endpoint: "https://push.example.com/sub-gate",
      p256dh:
        "BObSAMPLEp256dhKEYvaluethatislongenoughxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      auth: "authsecretvalue",
    });
    setLoginPushDisabledKinds(member, ["refill"]);

    const results = await dispatch(p, REFILL);
    expect(results).toEqual([{ id: "push", ok: true }]);
    expect(getNotifyError()).toBeNull();
  });
});
