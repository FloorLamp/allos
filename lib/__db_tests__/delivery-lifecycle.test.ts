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
import path from "node:path";
import webpush from "web-push";
import { rawDb as db } from "@/lib/db";
import {
  getLoginTelegram,
  setFoodNudgePointer,
  setLoginEmailNotify,
  setLoginTelegram,
  setProfileHomeAssistant,
  setSmtpConfig,
  setTelegramBotConfig,
  setUnitPrefs,
} from "@/lib/settings";
import { dispatch, getNotifyError } from "@/lib/notifications";
import {
  deletePushSubscription,
  ensureVapidKeys,
  savePushSubscription,
  sendTestPushToLogin,
} from "@/lib/notifications/push";
import { sendTestEmailToLogin } from "@/lib/notifications/email";
import { telegramChannel } from "@/lib/notifications/telegram";
import { PartialDeliveryError } from "@/lib/notifications/types";
import { liveMessagePointersForKind } from "@/lib/notifications/message-pointers";
import {
  classifyTelegramFailure,
  TelegramApiError,
} from "@/lib/notifications/telegram-error";
import {
  LEGACY_DELIVERY_HEALTH_KEY,
  readDeliveryOutcome,
  recordDeliveryOutcome,
} from "@/lib/notifications/delivery-marker";
import { up as addOwnerColumn } from "@/lib/migrations/versions/20260902-notify-lifecycle-owner";
import { seedLoginTelegram } from "./fixtures";
import { makeTmpDir } from "../__tests__/tmp-dir";

// web-push routes by endpoint suffix so one send can hold both outcomes.
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({
      publicKey: "vapid-public-0001",
      privateKey: "vapid-private-0001",
    }),
    setVapidDetails: () => {},
    sendNotification: vi.fn(async (sub: { endpoint: string }, _payload: string) => {
      if (sub.endpoint.endsWith("/ok")) return;
      const status = sub.endpoint.endsWith("/gone") ? 410 : 500;
      throw Object.assign(new Error(`push ${status}`), { statusCode: status });
    }),
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
      .run(`lifecycle login ${++loginSeq}`, email).lastInsertRowid
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
const stateOf = (
  channel: "telegram" | "push" | "email" | "home-assistant",
  owner: number
) => readDeliveryOutcome(channel, owner)?.state ?? null;

beforeEach(() => {
  db.prepare("DELETE FROM notify_lifecycle").run();
  setTelegramBotConfig({
    telegramBotToken: "bot-token-2565",
    telegramMode: "poll",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("Telegram owners", () => {
  it("renders for the shared chat's first owner and leaves an ownerless override canonical", async () => {
    const p = newProfile("Distance owner chats");
    const a = seedLoginTelegram(p, "units-shared");
    const b = seedLoginTelegram(p, "units-shared");
    const c = seedLoginTelegram(p, "units-own");
    for (const [login, distanceUnit] of [[a, "mi"], [b, "km"], [c, "km"]] as const)
      setUnitPrefs(login, { weightUnit: "kg", distanceUnit, temperatureUnit: "F" });
    stubWire();
    const msg = { title: "Recap", body: "canonical", kind: "recap" as const };
    const bodyForDistanceUnit = vi.fn((unit: "km" | "mi") => `distance in ${unit}`);
    await telegramChannel.send(p, msg, { bodyForDistanceUnit });
    const wire = vi.mocked(fetch);
    const bodies = wire.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies.map((body) => [body.chat_id, body.text])).toEqual([
      ["units-shared", expect.stringContaining("distance in mi")],
      ["units-own", expect.stringContaining("distance in km")],
    ]);
    expect([a, b, c].map((login) => stateOf("telegram", login))).toEqual([
      "delivering", "delivering", "delivering",
    ]);
    await telegramChannel.send(p, msg, {
      bodyForDistanceUnit,
      telegramChatIds: ["units-override"],
    });
    expect(JSON.parse(wire.mock.calls[2][1]!.body as string).text).toContain("canonical");
    expect(bodyForDistanceUnit).toHaveBeenCalledTimes(2);
  });

  it("records a renderer failure for every shared owner while the other chat still delivers", async () => {
    const p = newProfile("Distance render failure");
    const a = seedLoginTelegram(p, "render-shared");
    const b = seedLoginTelegram(p, "render-shared");
    const c = seedLoginTelegram(p, "render-healthy");
    setUnitPrefs(a, { weightUnit: "kg", distanceUnit: "mi", temperatureUnit: "F" });
    const calls = stubWire();
    await expect(telegramChannel.send(p, {
      title: "Recap", body: "canonical", kind: "recap",
    }, {
      bodyForDistanceUnit: (unit) => {
        if (unit === "mi") throw new Error("synthetic renderer failure");
        return "metric detail";
      },
    })).rejects.toBeInstanceOf(PartialDeliveryError);
    expect(calls.filter((url) => url.includes("sendMessage"))).toHaveLength(1);
    expect([a, b, c].map((login) => stateOf("telegram", login))).toEqual([
      "failing", "failing", "delivering",
    ]);
  });

  it("a fresh chat is Ready (no row); one send lands on EVERY login behind a shared chat; another chat's error survives it", async () => {
    const p = newProfile("Shared chat");
    const a = seedLoginTelegram(p, "chat-shared");
    const b = seedLoginTelegram(p, "chat-shared");
    const c = seedLoginTelegram(p, "chat-own");
    expect([a, b, c].map((l) => stateOf("telegram", l))).toEqual([
      null,
      null,
      null,
    ]);

    // C's chat is already Erroring from an earlier attempt.
    recordDeliveryOutcome("telegram", [c], {
      ok: false,
      error: "chat not found",
    });

    const calls = stubWire();
    const results = await dispatch(p, DOSE);
    expect(results).toEqual([{ id: "telegram", ok: true, delivered: true }]);
    // TWO sends for three logins: the shared chat once, C's chat once.
    expect(calls.filter((u) => u.includes("sendMessage"))).toHaveLength(2);
    expect([a, b, c].map((l) => stateOf("telegram", l))).toEqual([
      "delivering",
      "delivering",
      "delivering",
    ]);
  });

  describe.each(["managed", "override"] as const)(
    "%s recipient failures",
    (route) => {
      it("reaches healthy tail chats before simultaneous transport timeouts settle", async () => {
        vi.useFakeTimers();
        const p = newProfile("Transport timeouts");
        const chats = [
          "good-first",
          "timeout-1",
          "timeout-2",
          "timeout-3",
          "timeout-4",
          "timeout-5",
          "good-last",
        ];
        const owners = chats.map((chat) => seedLoginTelegram(p, chat));
        const attempted: string[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const { chat_id: chatId } = JSON.parse(String(init?.body));
            attempted.push(chatId);
            if (chatId.startsWith("timeout")) {
              return await new Promise<Response>((_resolve, reject) => {
                setTimeout(
                  () =>
                    reject(
                      new DOMException("request timed out", "TimeoutError")
                    ),
                  30_000
                );
              });
            }
            return new Response(
              JSON.stringify({ ok: true, result: { message_id: 17 } }),
              { status: 200 }
            );
          })
        );

        const pending = dispatch(
          p,
          DOSE,
          route === "override" ? { telegramChatIds: chats } : undefined
        );
        // All recipients start before even the first stalled transport times out.
        expect(attempted).toEqual(chats);
        await vi.advanceTimersByTimeAsync(30_000);
        const [result] = await pending;
        expect(result).toMatchObject({ ok: false, delivered: true });
        expect(result.timedOut).toBeUndefined();
        expect(owners.map((owner) => stateOf("telegram", owner))).toEqual(
          chats.map((chat) =>
            route === "override"
              ? null
              : chat.startsWith("good")
                ? "delivering"
                : "failing"
          )
        );
      });

      it.each([
        [403, 200, 200],
        [200, 403, 200],
        [200, 200, 503],
        [403, 503, 429],
      ])(
        "attempts every chat for HTTP outcomes %i, %i, %i",
        async (...statuses) => {
          const failed = statuses.flatMap((status, index) =>
            status === 200 ? [] : [index]
          );
          const p = newProfile("Recipient isolation");
          const chats = ["chat-first", "chat-middle", "chat-last"];
          const owners = chats.map((chat) => seedLoginTelegram(p, chat));
          const attempted: string[] = [];
          vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
              const { chat_id: chatId } = JSON.parse(String(init?.body));
              attempted.push(chatId);
              const fails = failed.includes(chats.indexOf(chatId));
              return new Response(
                JSON.stringify(
                  fails
                    ? { ok: false, description: `Failure for ${chatId}` }
                    : { ok: true, result: { message_id: 7 } }
                ),
                {
                  status: statuses[chats.indexOf(chatId)],
                  headers: { "content-type": "application/json" },
                }
              );
            })
          );

          const [result] = await dispatch(
            p,
            DOSE,
            route === "override"
              ? { telegramChatIds: [...chats, chats[0]] }
              : undefined
          );
          expect(attempted).toEqual(chats);
          expect(result).toMatchObject({
            ok: false,
            delivered: failed.length < chats.length,
          });
          for (const index of failed)
            expect(result.error).toContain(chats[index]);
          // Overrides name no login: even a coincident managed chat cannot claim their
          // outcome. Managed sends record every owner independently, including the last.
          expect(owners.map((owner) => stateOf("telegram", owner))).toEqual(
            chats.map((_, index) =>
              route === "override"
                ? null
                : failed.includes(index)
                  ? "failing"
                  : "delivering"
            )
          );
          if (route === "managed") expect(getNotifyError()).not.toBeNull();
          expect(
            owners.map((owner) => getLoginTelegram(owner).telegramEnabled)
          ).toEqual([true, true, true]);
        }
      );
    }
  );

  it("serializes shared food-pointer rotation while sending to both chats", async () => {
    vi.useFakeTimers();
    const p = newProfile("Shared pointer ordering");
    const chats = ["chat-first", "chat-last"];
    chats.forEach((chat) => seedLoginTelegram(p, chat));
    setFoodNudgePointer(p, {
      chatId: "chat-old",
      messageId: 1,
      date: "2026-09-07",
      window: "Morning",
    });
    const sent: string[] = [];
    const stripped: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const { chat_id: chatId } = JSON.parse(String(init?.body));
        if (String(url).endsWith("sendMessage")) sent.push(chatId);
        else {
          stripped.push(chatId);
          if (chatId === "chat-old")
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 17 } }),
          { status: 200 }
        );
      })
    );
    const pending = dispatch(p, {
      title: "Food",
      body: "Synthetic reminder",
      kind: "food",
      actions: [{ label: "Fruit", data: `food:${p}:Morning:2026-09-07:fruit` }],
    });
    expect(sent).toEqual(chats);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual([
      { id: "telegram", ok: true, delivered: true },
    ]);
    expect(stripped).toEqual(["chat-old", "chat-first"]);
    // A later rotation stripped the first copy. It must not reappear as a live
    // pointer when that copy's earlier, delayed predecessor edit finally settles.
    expect(liveMessagePointersForKind(p, "chat-first", "food")).toHaveLength(0);
    expect(liveMessagePointersForKind(p, "chat-last", "food")).toHaveLength(1);
  });

  // THE WRAPPER KEEPS THE ERROR IT WRAPS (#5194, eleventh pass). `delivered` rides out
  // past the throw inside a PartialDeliveryError, and the thing being wrapped is the
  // transport's TelegramApiError — typed by #1885 precisely so classification reads a
  // status and a description rather than a sentence. A wrapper that kept only the
  // sentence would flip an unrecognised 403 from permanent to transient, and the
  // reconcile sweep would go on retrying a pointer into a chat that has blocked the bot.
  // Nothing on the dispatch path reads this yet; that is why it is pinned here rather
  // than left to be discovered.
  it("the partial-delivery wrapper keeps the typed error, so classification is unchanged", async () => {
    const p = newProfile("Wrapped throw");
    seedLoginTelegram(p, "chat-good");
    seedLoginTelegram(p, "chat-blocked");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        String(init?.body ?? "").includes("chat-blocked")
          ? new Response(
              JSON.stringify({
                ok: false,
                description: "Forbidden: CHAT_RESTRICTED",
              }),
              { status: 403, headers: { "content-type": "application/json" } }
            )
          : new Response(
              JSON.stringify({ ok: true, result: { message_id: 7 } }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            )
      )
    );

    const thrown = await telegramChannel
      .send(p, DOSE)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(PartialDeliveryError);
    expect((thrown as Error).cause).toBeInstanceOf(TelegramApiError);
    expect(((thrown as Error).cause as TelegramApiError).status).toBe(403);
    // The description Telegram gave is one the permanent list does NOT match, so the
    // verdict rests entirely on the status surviving the wrap.
    expect(classifyTelegramFailure(thrown)).toBe("permanent");
  });

  it("a failure moves the addressed logins to Erroring, and one login's success does not clear another's", async () => {
    const p = newProfile("Two chats");
    const a = seedLoginTelegram(p, "chat-a");
    const q = newProfile("Other subject");
    const z = seedLoginTelegram(q, "chat-z");

    stubWire({ telegramOk: false });
    await dispatch(q, DOSE);
    expect(stateOf("telegram", z)).toBe("failing");
    expect(readDeliveryOutcome("telegram", z)?.detail).toContain(
      "Unauthorized"
    );

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
    expect([stateOf("telegram", a), stateOf("telegram", b)]).toEqual([
      null,
      "delivering",
    ]);

    setTelegramBotConfig({
      telegramBotToken: "bot-token-2565",
      telegramMode: "webhook",
    });
    expect(stateOf("telegram", b)).toBe("delivering");
    setTelegramBotConfig({
      telegramBotToken: "bot-token-new",
      telegramMode: "poll",
    });
    expect(stateOf("telegram", b)).toBeNull();
  });
});

describe("Web Push owners", () => {
  it("uses each subscription owner's units and isolates renderer failure", async () => {
    ensureVapidKeys();
    const p = newProfile("Push distance recipients");
    const metric = newLogin();
    const imperial = newLogin();
    for (const [login, distanceUnit] of [[metric, "km"], [imperial, "mi"]] as const) {
      db.prepare("INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')").run(login, p);
      setUnitPrefs(login, { weightUnit: "kg", distanceUnit, temperatureUnit: "F" });
      savePushSubscription(login, {
        endpoint: `https://push.example/${login}/ok`, p256dh: "p256dh-0001", auth: "auth-0001",
      });
    }
    const wire = vi.mocked(webpush.sendNotification);
    wire.mockClear();
    const msg = { title: "Recap", body: "canonical", kind: "recap" as const };
    await dispatch(p, msg, { bodyForDistanceUnit: (unit) => `distance in ${unit}` });
    expect(Object.fromEntries(wire.mock.calls.map(([sub, payload]) => [sub.endpoint, JSON.parse(String(payload)).body]))).toEqual({
      [`https://push.example/${metric}/ok`]: "distance in km",
      [`https://push.example/${imperial}/ok`]: "distance in mi",
    });
    wire.mockClear();
    await dispatch(p, msg, { bodyForDistanceUnit: (unit) => {
      if (unit === "mi") throw new Error("synthetic renderer failure");
      return "metric detail";
    } });
    expect(wire).toHaveBeenCalledTimes(1);
    expect([metric, imperial].map((login) => stateOf("push", login))).toEqual([
      "delivering", "failing",
    ]);
  });

  it.each([
    {
      name: "partial success is Delivering",
      endpoints: ["/ok", "/fail"],
      state: "delivering",
      throws: false,
      left: 2,
    },
    {
      name: "every live attempt failing is Erroring",
      endpoints: ["/fail", "/fail"],
      state: "failing",
      throws: true,
      left: 2,
    },
    {
      name: "the last browser pruned leaves no row and no subscription",
      endpoints: ["/gone"],
      state: null,
      throws: false,
      left: 0,
    },
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
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM push_subscriptions WHERE login_id = ?"
          )
          .get(login) as { n: number }
      ).n
    ).toBe(left);
  });

  // HEALTHY, AND NOBODY WAS REACHED — the shape that has no throw to announce it
  // (#5194, eleventh falsifying pass). Every browser has unsubscribed: the push service
  // answers 410 Gone, `sendToSubscriptions` prunes each endpoint and returns WITHOUT
  // counting either a success or an error, so `ok === 0 && errors.length === 0` and the
  // channel finishes cleanly. `ok: true` is right — nothing failed, the slot must not
  // retry, and no delivery-health marker may be set — and `delivered: false` is the fact
  // a caller whose correctness depends on a person having SEEN the message needs.
  //
  // This is the reachable divergence for `kind: "other"`, which is what the "Still
  // working out?" nudge is: `other` is NON_CONFIGURABLE, so `parseDisabledKinds` strips
  // it and no per-kind gate can filter that family. Recording the minute that nudge
  // promised on `ok` would have recorded a promise no browser was still receiving.
  it("every subscription pruned as Gone is a healthy channel that DELIVERED to nobody", async () => {
    ensureVapidKeys();
    const p = newProfile("All browsers gone");
    const login = newLogin();
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(login, p);
    for (const i of [0, 1])
      savePushSubscription(login, {
        endpoint: `https://push.example/${login}-${i}/gone`,
        p256dh: "p256dh-0001",
        auth: "auth-0001",
      });

    const results = await dispatch(p, { ...DOSE, kind: "other" });

    expect(results).toEqual([{ id: "push", ok: true, delivered: false }]);
    // The control on "nobody was reached": the endpoints are gone, not merely quiet.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM push_subscriptions WHERE login_id = ?"
          )
          .get(login) as { n: number }
      ).n
    ).toBe(0);
    expect(getNotifyError()).toBeNull();
    expect(stateOf("push", login)).toBeNull();
  });

  it("subscribing or unsubscribing a browser returns the login to Ready", () => {
    ensureVapidKeys();
    const login = newLogin();
    const sub = {
      endpoint: `https://push.example/${login}/ok`,
      p256dh: "p256dh-0001",
      auth: "auth-0001",
    };
    savePushSubscription(login, sub);
    recordDeliveryOutcome("push", [login], { ok: true });
    savePushSubscription(login, {
      ...sub,
      endpoint: `https://push.example/${login}-b/ok`,
    });
    expect(stateOf("push", login)).toBeNull();
    recordDeliveryOutcome("push", [login], { ok: true });
    deletePushSubscription(login, sub.endpoint);
    expect(stateOf("push", login)).toBeNull();
  });
});

describe("Email owners", () => {
  it("a test mail moves only the sending login; the relay or the enable toggle out-dates it", async () => {
    setSmtpConfig({
      host: "smtp.example.com",
      port: 587,
      user: "",
      from: "allos@example.com",
    });
    const dir = makeTmpDir("lifecycle-mail");
    process.env.EMAIL_TEST_CAPTURE = path.join(dir, "mailbox.jsonl");
    const a = newLogin("a-lifecycle@example.com");
    const b = newLogin("b-lifecycle@example.com");
    for (const l of [a, b])
      setLoginEmailNotify(l, { emailEnabled: true, emailFullContent: false });
    recordDeliveryOutcome("email", [b], { ok: false, error: "relay refused" });

    await expect(sendTestEmailToLogin(a)).resolves.toBe("sent");
    expect([stateOf("email", a), stateOf("email", b)]).toEqual([
      "delivering",
      "failing",
    ]);

    // Content mode is not a target change; the enable toggle is.
    setLoginEmailNotify(a, { emailEnabled: true, emailFullContent: true });
    expect(stateOf("email", a)).toBe("delivering");
    setLoginEmailNotify(a, { emailEnabled: false, emailFullContent: true });
    expect(stateOf("email", a)).toBeNull();
    setSmtpConfig({
      host: "smtp2.example.com",
      port: 587,
      user: "",
      from: "allos@example.com",
    });
    expect(stateOf("email", b)).toBeNull();
  });
});

describe("Home Assistant owner", () => {
  it("records the profile; a routing-only write keeps the row, a target change drops it", async () => {
    const p = newProfile("HA lifecycle");
    const cfg = {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: [],
    };
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
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM notify_lifecycle WHERE owner_id IS NOT NULL"
        )
        .get()
    ).toEqual({ n: 0 });

    // Another channel's scoped failure outranks the fallback but does not retire it.
    recordDeliveryOutcome("home-assistant", [1], {
      ok: false,
      error: "HTTP 500",
    });
    expect(getNotifyError()?.channel).toBe("home-assistant");
    db.prepare("DELETE FROM notify_lifecycle WHERE owner_id IS NOT NULL").run();

    recordDeliveryOutcome("telegram", [1], { ok: true });
    expect(getNotifyError()).toBeNull();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM notify_lifecycle WHERE key = ?")
        .get(LEGACY_DELIVERY_HEALTH_KEY)
    ).toEqual({ n: 0 });
  });
});
