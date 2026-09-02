// DB INTEGRATION TIER — the SCOPED delivery lifecycle (#2565 A), end to end over the
// real channels at the network seam (fetch stubbed for Telegram and Home Assistant,
// web-push's transport mocked, the mail relay replaced by the capture sink). What
// this pins, that the pure tier can't:
//
//   1. a fresh configuration has NO row — Ready, never Delivering — and a send moves
//      only the owners it reached: one login's success cannot clear another's error;
//   2. a shared Telegram chat is ONE send whose outcome lands on every login mapped
//      to it;
//   3. Web Push per login: any browser succeeding is Delivering, every live attempt
//      failing is Erroring, and the last browser pruned leaves nothing to be about;
//   4. a configuration write for an owner (or for a whole channel) deletes the rows
//      it out-dates; a routing-only write does not;
//   5. the pre-#2565 instance-wide row is the aggregate's honest fallback and is
//      retired by the first scoped attempt on its channel — never rewritten into a
//      per-owner state.
//
// Every value is synthetic: fake chat ids, a fake bot token, example.com addresses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import {
  setLoginEmailNotify,
  setLoginTelegram,
  setProfileHomeAssistant,
  setSmtpConfig,
  setTelegramBotConfig,
} from "@/lib/settings";
import { dispatch, getNotifyError } from "@/lib/notifications";
import {
  deletePushSubscription,
  ensureVapidKeys,
  savePushSubscription,
  sendTestPushToLogin,
} from "@/lib/notifications/push";
import { sendTestEmailToLogin } from "@/lib/notifications/email";
import {
  LEGACY_DELIVERY_HEALTH_KEY,
  readDeliveryOutcome,
  recordDeliveryOutcome,
} from "@/lib/notifications/delivery-marker";
import { up as addOwnerColumn } from "@/lib/migrations/versions/20260902-notify-lifecycle-owner";
import { seedLoginTelegram } from "./fixtures";

// web-push routes by endpoint suffix so one send can hold both outcomes.
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({
      publicKey: "vapid-public-0001",
      privateKey: "vapid-private-0001",
    }),
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/ok")) return;
      const status = sub.endpoint.endsWith("/gone") ? 410 : 500;
      throw Object.assign(new Error(`push ${status}`), { statusCode: status });
    },
  },
}));

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-lifecycle";
const DOSE = { title: "Dose", body: "Vitamin D", kind: "dose" as const };

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
let loginSeq = 0;
function newLogin(email: string | null = null): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role, email) VALUES (?, 'x', 'member', ?)"
      )
      .run(`lifecycle login ${++loginSeq}`, email)
      .lastInsertRowid
  );
}
function stubWire(opts: { telegramOk?: boolean; haStatus?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("api.telegram.org")) {
        return (opts.telegramOk ?? true)
          ? new Response(
              JSON.stringify({ ok: true, result: { message_id: 7 } }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          : new Response(
              JSON.stringify({ ok: false, description: "Unauthorized" }),
              { status: 401, headers: { "content-type": "application/json" } }
            );
      }
      return new Response(null, { status: opts.haStatus ?? 200 });
    })
  );
  return calls;
}
const stateOf = (channel: "telegram" | "push" | "email" | "home-assistant", owner: number) =>
  readDeliveryOutcome(channel, owner)?.state ?? null;

beforeEach(() => {
  db.prepare("DELETE FROM notify_lifecycle").run();
  setTelegramBotConfig({ telegramBotToken: "bot-token-2565", telegramMode: "poll" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("Telegram owners", () => {
  it("a fresh chat is Ready (no row); one send lands on EVERY login behind a shared chat; another chat's error survives it", async () => {
    const p = newProfile("Shared chat");
    const a = seedLoginTelegram(p, "chat-shared");
    const b = seedLoginTelegram(p, "chat-shared");
    const c = seedLoginTelegram(p, "chat-own");
    expect([a, b, c].map((l) => stateOf("telegram", l))).toEqual([null, null, null]);

    // C's chat is already Erroring from an earlier attempt.
    recordDeliveryOutcome("telegram", [c], { ok: false, error: "chat not found" });

    const calls = stubWire();
    const results = await dispatch(p, DOSE);
    expect(results).toEqual([{ id: "telegram", ok: true }]);
    // TWO sends for three logins: the shared chat once, C's chat once.
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(2);
    expect([a, b, c].map((l) => stateOf("telegram", l))).toEqual([
      "delivering",
      "delivering",
      "delivering",
    ]);
  });

  it("a failure moves the addressed logins to Erroring, and one login's success does not clear another's", async () => {
    const p = newProfile("Two chats");
    const a = seedLoginTelegram(p, "chat-a");
    const q = newProfile("Other subject");
    const z = seedLoginTelegram(q, "chat-z");

    stubWire({ telegramOk: false });
    await dispatch(q, DOSE);
    expect(stateOf("telegram", z)).toBe("failing");
    expect(readDeliveryOutcome("telegram", z)?.detail).toContain("Unauthorized");

    vi.unstubAllGlobals();
    stubWire({ telegramOk: true });
    await dispatch(p, DOSE);
    expect(stateOf("telegram", a)).toBe("delivering");
    expect(stateOf("telegram", z)).toBe("failing");
    expect(getNotifyError()?.channel).toBe("telegram");
  });

  it("reconfiguring the chat returns THAT login to Ready; a new bot token returns every Telegram owner", () => {
    const a = newLogin();
    const b = newLogin();
    setLoginTelegram(a, { telegramEnabled: true, telegramChatId: "chat-1" });
    setLoginTelegram(b, { telegramEnabled: true, telegramChatId: "chat-2" });
    recordDeliveryOutcome("telegram", [a, b], { ok: true });

    // Same config re-saved: nothing out-dated.
    setLoginTelegram(a, { telegramEnabled: true, telegramChatId: "chat-1" });
    expect(stateOf("telegram", a)).toBe("delivering");
    setLoginTelegram(a, { telegramEnabled: true, telegramChatId: "chat-9" });
    expect([stateOf("telegram", a), stateOf("telegram", b)]).toEqual([null, "delivering"]);

    setTelegramBotConfig({ telegramBotToken: "bot-token-2565", telegramMode: "webhook" });
    expect(stateOf("telegram", b)).toBe("delivering");
    setTelegramBotConfig({ telegramBotToken: "bot-token-new", telegramMode: "poll" });
    expect(stateOf("telegram", b)).toBeNull();
  });
});

describe("Web Push owners", () => {
  it.each([
    { name: "partial success is Delivering", endpoints: ["/ok", "/fail"], state: "delivering", throws: false, left: 2 },
    { name: "every live attempt failing is Erroring", endpoints: ["/fail", "/fail"], state: "failing", throws: true, left: 2 },
    { name: "the last browser pruned leaves no row and no subscription", endpoints: ["/gone"], state: null, throws: false, left: 0 },
  ])("$name", async ({ endpoints, state, throws, left }) => {
    ensureVapidKeys();
    const login = newLogin();
    endpoints.forEach((suffix, i) =>
      savePushSubscription(login, {
        endpoint: `https://push.example/${login}-${i}${suffix}`,
        p256dh: "p256dh-0001",
        auth: "auth-0001",
      })
    );
    const send = sendTestPushToLogin(login, { ...DOSE, kind: "test" });
    if (throws) await expect(send).rejects.toThrow("web-push failed");
    else await expect(send).resolves.toBe(endpoints.length);
    expect(stateOf("push", login)).toBe(state);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE login_id = ?").get(login) as { n: number }).n
    ).toBe(left);
  });

  it("subscribing or unsubscribing a browser returns the login to Ready", () => {
    ensureVapidKeys();
    const login = newLogin();
    const sub = { endpoint: `https://push.example/${login}/ok`, p256dh: "p256dh-0001", auth: "auth-0001" };
    savePushSubscription(login, sub);
    recordDeliveryOutcome("push", [login], { ok: true });
    savePushSubscription(login, { ...sub, endpoint: `https://push.example/${login}-b/ok` });
    expect(stateOf("push", login)).toBeNull();
    recordDeliveryOutcome("push", [login], { ok: true });
    deletePushSubscription(login, sub.endpoint);
    expect(stateOf("push", login)).toBeNull();
  });
});

describe("Email owners", () => {
  it("a test mail moves only the sending login; the relay or the enable toggle out-dates it", async () => {
    setSmtpConfig({ host: "smtp.example.com", port: 587, user: "", from: "allos@example.com" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-mail-"));
    process.env.EMAIL_TEST_CAPTURE = path.join(dir, "mailbox.jsonl");
    const a = newLogin("a-lifecycle@example.com");
    const b = newLogin("b-lifecycle@example.com");
    for (const l of [a, b]) setLoginEmailNotify(l, { emailEnabled: true, emailFullContent: false });
    recordDeliveryOutcome("email", [b], { ok: false, error: "relay refused" });

    await expect(sendTestEmailToLogin(a)).resolves.toBe("sent");
    expect([stateOf("email", a), stateOf("email", b)]).toEqual(["delivering", "failing"]);

    // Content mode is not a target change; the enable toggle is.
    setLoginEmailNotify(a, { emailEnabled: true, emailFullContent: true });
    expect(stateOf("email", a)).toBe("delivering");
    setLoginEmailNotify(a, { emailEnabled: false, emailFullContent: true });
    expect(stateOf("email", a)).toBeNull();
    setSmtpConfig({ host: "smtp2.example.com", port: 587, user: "", from: "allos@example.com" });
    expect(stateOf("email", b)).toBeNull();
  });
});

describe("Home Assistant owner", () => {
  it("records the profile; a routing-only write keeps the row, a target change drops it", async () => {
    const p = newProfile("HA lifecycle");
    const cfg = { enabled: true, webhookUrl: HA_URL, secret: "", disabledKinds: [] };
    setProfileHomeAssistant(p, cfg);
    expect(stateOf("home-assistant", p)).toBeNull();

    stubWire({ haStatus: 500 });
    await dispatch(p, DOSE);
    expect(stateOf("home-assistant", p)).toBe("failing");
    expect(getNotifyError()).toMatchObject({ channel: "home-assistant" });

    setProfileHomeAssistant(p, { ...cfg, disabledKinds: ["weekly-recap"] });
    expect(stateOf("home-assistant", p)).toBe("failing");
    setProfileHomeAssistant(p, { ...cfg, webhookUrl: `${HA_URL}-2` });
    expect(stateOf("home-assistant", p)).toBeNull();
  });
});

describe("the pre-#2565 instance-wide row", () => {
  it("survives the migration as the aggregate's fallback, invents no owner state, and retires on the first scoped attempt for its channel", () => {
    db.prepare(
      `INSERT INTO notify_lifecycle (key, state, channel, detail, at)
         VALUES (?, 'failing', 'telegram', 'Telegram API 401', '2026-07-09T08:00:00Z')`
    ).run(LEGACY_DELIVERY_HEALTH_KEY);
    // Replay-safe: the column already exists on the migrated test DB.
    expect(() => addOwnerColumn(db)).not.toThrow();

    expect(getNotifyError()).toEqual({
      error: "Telegram API 401",
      at: "2026-07-09T08:00:00Z",
      channel: "telegram",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notify_lifecycle WHERE owner_id IS NOT NULL").get()
    ).toEqual({ n: 0 });

    // Another channel's scoped failure outranks the fallback but does not retire it.
    recordDeliveryOutcome("home-assistant", [1], { ok: false, error: "HTTP 500" });
    expect(getNotifyError()?.channel).toBe("home-assistant");
    db.prepare("DELETE FROM notify_lifecycle WHERE owner_id IS NOT NULL").run();

    recordDeliveryOutcome("telegram", [1], { ok: true });
    expect(getNotifyError()).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notify_lifecycle WHERE key = ?").get(LEGACY_DELIVERY_HEALTH_KEY)
    ).toEqual({ n: 0 });
  });
});
