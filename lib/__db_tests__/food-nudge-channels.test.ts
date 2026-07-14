// DB INTEGRATION TIER — which CHANNELS a food-log nudge reaches (issue #692).
//
// The food nudge is a button-driven Telegram feature; Web Push drops actions
// (buildPushPayload carries only title/body/url), so fanning the nudge out to push
// delivers a content-less, button-less "tap what you've eaten" notification. The tick's
// telegramChannel.isConfigured guard only covers "Telegram off, flag stuck on" — it does
// nothing for the ordinary both-channels case (Telegram AND Web Push both on), where the
// nudge still reaches dispatch() and fans to push. The fix self-gates food-kind messages
// at the push channel (isPushDeliverableKind); this pins that a profile with BOTH channels
// configured gets the food nudge via Telegram ONLY, while other kinds still reach push.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Stub the two network surfaces (Telegram send + web-push) so dispatch() exercises the
// real channel routing without any I/O.
vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return { ...actual, sendMessageRaw: vi.fn(async () => {}) };
});
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(() => {}),
    sendNotification: vi.fn(async () => {}),
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "test-public",
      privateKey: "test-private",
    })),
  },
}));

import webpush from "web-push";
import { db } from "@/lib/db";
import { setSetting, setProfileSetting } from "@/lib/settings";
import { dispatch } from "@/lib/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import type { NotificationMessage } from "@/lib/notifications/types";

const sendTelegram = vi.mocked(sendMessageRaw);
const sendPush = vi.mocked(webpush.sendNotification);

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

let profileId: number;

beforeAll(() => {
  profileId = makeProfile("food-both-channels");

  // Channel 1 — Telegram: a global bot token + this profile's enabled flag + chat id.
  setSetting("telegram_bot_token", "test-bot-token");
  setProfileSetting(profileId, "telegram_enabled", "1");
  setProfileSetting(profileId, "telegram_chat_id", "5550100");

  // Channel 2 — Web Push: instance VAPID keys + a subscription owned by an admin login
  // (admins reach every profile, so the subscription is entitled to this profile).
  setSetting("vapid_public_key", "test-public");
  setSetting("vapid_private_key", "test-private");
  const adminId = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES ('food-admin', 'x', 'admin')"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, login_id, p256dh, auth)
     VALUES ('https://push.example/ep-1', ?, 'p', 'a')`
  ).run(adminId);
});

beforeEach(() => {
  sendTelegram.mockClear();
  sendPush.mockClear();
});

describe("food nudge channel fan-out with Telegram + Web Push both configured (#692)", () => {
  it("delivers the food nudge over Telegram only, never Web Push", async () => {
    const nudge = buildFoodNudge(profileId, "Morning", "2026-07-14");
    expect(nudge).not.toBeNull();
    expect(nudge!.kind).toBe("food");

    const results = await dispatch(profileId, nudge!);

    // Both channels are configured and dispatch reports both healthy...
    expect(results.map((r) => r.id).sort()).toEqual(["push", "telegram"]);
    expect(results.every((r) => r.ok)).toBe(true);

    // ...but only Telegram actually sent anything. Web Push no-oped the food kind.
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("still delivers a non-food kind over BOTH channels (the gate is food-specific)", async () => {
    const doseMsg: NotificationMessage = {
      title: "Morning supplements",
      body: "Time for your morning supplements: Vitamin D, Magnesium.",
      kind: "dose",
    };

    await dispatch(profileId, doseMsg);

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
});
