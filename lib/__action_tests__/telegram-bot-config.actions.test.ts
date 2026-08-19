// SERVER-ACTION TIER — saveTelegramBotConfig registers the `/` command menu
// (#3076), driven against the fake Telegram API (global fetch stubbed at the
// network seam, the telegram-api-errors precedent; nothing mocked above it).
//
// #1895 specified registration "at bot-config time"; the implementation landed
// it in registerTelegramWebhook instead, so every POLLING instance — the default
// transport, whose Register-webhook button doesn't even render — had no command
// menu at all. What this pins:
//
//   1. saving a token registers the menu in BOTH transport modes — poll and
//      webhook — with exactly registrableCommands();
//   2. a failing setMyCommands never fails the save (the deleteWebhook
//      precedent) and the token still persists;
//   3. no token saved ⇒ no Telegram call at all (graceful degradation);
//   4. registerTelegramWebhook no longer registers the menu itself — one
//      registration site, not two that can disagree.
//
// Every value is synthetic: a fake bot token, a fake public URL.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerTelegramWebhook,
  saveTelegramBotConfig,
} from "@/app/(app)/settings/server/actions";
import { getTelegramBotConfig, setPublicUrl } from "@/lib/settings";
import { registrableCommands } from "@/lib/notifications/telegram-commands";
import { createLogin, createProfile, actAs, fd } from "./harness";

interface WireCall {
  method: string;
  body: unknown;
}

// Stub the Bot API wire, recording every method called. `failing` names methods
// answered with Telegram's error shape instead of success.
function stubTelegramWire(failing: string[] = []): WireCall[] {
  const calls: WireCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      expect(target).toContain("api.telegram.org");
      const method = target.split("/").pop()!;
      calls.push({ method, body: JSON.parse(String(init?.body)) });
      if (failing.includes(method)) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: forced" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

function actAsAdmin(): void {
  const login = createLogin({ role: "admin" });
  const profile = createProfile(`telegram-admin-${login.id}`, login.id);
  actAs(login, profile);
}

beforeEach(() => {
  actAsAdmin();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveTelegramBotConfig registers the command menu (#3076)", () => {
  it("a POLLING instance that saves a token gets the `/` menu", async () => {
    const calls = stubTelegramWire();
    await saveTelegramBotConfig(
      fd({ telegram_bot_token: "bot-token-poll-3076", telegram_mode: "poll" })
    );
    const menu = calls.filter((c) => c.method === "setMyCommands");
    expect(menu).toHaveLength(1);
    expect(menu[0].body).toEqual({ commands: registrableCommands() });
    expect(getTelegramBotConfig().telegramMode).toBe("poll");
  });

  it("a WEBHOOK instance gets the same menu from the same save", async () => {
    const calls = stubTelegramWire();
    await saveTelegramBotConfig(
      fd({
        telegram_bot_token: "bot-token-hook-3076",
        telegram_mode: "webhook",
      })
    );
    const menu = calls.filter((c) => c.method === "setMyCommands");
    expect(menu).toHaveLength(1);
    expect(menu[0].body).toEqual({ commands: registrableCommands() });
    expect(getTelegramBotConfig().telegramMode).toBe("webhook");
  });

  it("a failing registration never fails the save, and the token persists", async () => {
    const calls = stubTelegramWire(["setMyCommands"]);
    await expect(
      saveTelegramBotConfig(
        fd({ telegram_bot_token: "bot-token-flaky-3076", telegram_mode: "poll" })
      )
    ).resolves.toBeUndefined();
    expect(calls.some((c) => c.method === "setMyCommands")).toBe(true);
    expect(getTelegramBotConfig().telegramBotToken).toBe(
      "bot-token-flaky-3076"
    );
  });

  it("saving with NO token makes no Telegram call at all", async () => {
    const calls = stubTelegramWire();
    await saveTelegramBotConfig(
      fd({ telegram_bot_token: "", telegram_mode: "poll" })
    );
    expect(calls).toHaveLength(0);
  });

  it("a webhook→poll mode switch still drops the webhook AND registers the menu", async () => {
    const calls = stubTelegramWire();
    await saveTelegramBotConfig(
      fd({
        telegram_bot_token: "bot-token-switch-3076",
        telegram_mode: "webhook",
      })
    );
    calls.length = 0;
    await saveTelegramBotConfig(
      fd({ telegram_bot_token: "bot-token-switch-3076", telegram_mode: "poll" })
    );
    expect(calls.map((c) => c.method)).toEqual([
      "deleteWebhook",
      "setMyCommands",
    ]);
  });

  it("registerTelegramWebhook registers the webhook only — setMyCommands has ONE call site", async () => {
    const calls = stubTelegramWire();
    setPublicUrl("https://allos.example.com");
    await saveTelegramBotConfig(
      fd({
        telegram_bot_token: "bot-token-hook2-3076",
        telegram_mode: "webhook",
      })
    );
    calls.length = 0;

    const res = await registerTelegramWebhook();
    expect(res).toEqual({ ok: true, message: "Webhook registered ✅" });
    expect(calls.map((c) => c.method)).toEqual(["setWebhook"]);
  });
});
