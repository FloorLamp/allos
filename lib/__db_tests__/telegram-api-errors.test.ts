// DB INTEGRATION TIER (#1885) — the TRANSPORT half of the failure-classification fix,
// driven at the network seam with global fetch stubbed and nothing mocked above it.
//
// The reconcile sweep's decision (lib/__db_tests__/message-reconcile.test.ts) is only as
// good as the error the wire actually produces. What this pins: every Bot API failure
// mode leaves lib/notifications/telegram-api.ts as a TelegramApiError carrying the HTTP
// status and Telegram's own `description`, and each one classifies the way the sweep
// depends on. The bot token lives in settings, so this needs a live schema — hence the
// DB tier rather than the pure one.
//
// Every value here is synthetic: a fake bot token, fake chat ids, fake message ids.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setTelegramBotConfig } from "@/lib/settings";
import { editMessageTextRaw } from "@/lib/notifications/telegram-api";
import {
  classifyTelegramFailure,
  TelegramApiError,
} from "@/lib/notifications/telegram-error";

beforeEach(() => {
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Answer every Bot API POST with one canned response.
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

// Make the request itself fail before any answer exists.
function stubFetchThrowing(e: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw e;
    })
  );
}

async function editFailure(): Promise<TelegramApiError> {
  const e = await editMessageTextRaw("5551885", 42, "hello").catch(
    (err: unknown) => err
  );
  expect(e, "the edit should have thrown").toBeInstanceOf(TelegramApiError);
  return e as TelegramApiError;
}

describe("the transport types every Bot API failure (#1885)", () => {
  it("carries the description Telegram gave for a dead message", async () => {
    // Telegram's answer for a message that no longer exists.
    stubFetch(400, {
      ok: false,
      description: "Bad Request: message to edit not found",
    });
    const e = await editFailure();
    expect(e.status).toBe(400);
    expect(e.description).toBe("Bad Request: message to edit not found");
    expect(e.method).toBe("editMessageText");
    expect(classifyTelegramFailure(e)).toBe("permanent");
  });

  it("carries the status when Telegram answers without a description", async () => {
    stubFetch(502, "");
    const e = await editFailure();
    expect(e.status).toBe(502);
    expect(e.description).toBeNull();
    // The regression this file exists for: a 5xx used to be indistinguishable from a
    // deleted message, so one bad gateway forgot a live pointer forever.
    expect(classifyTelegramFailure(e)).toBe("transient");
  });

  it("types a rate limit as itself", async () => {
    stubFetch(429, {
      ok: false,
      description: "Too Many Requests: retry after 30",
      parameters: { retry_after: 30 },
    });
    const e = await editFailure();
    expect(e.status).toBe(429);
    expect(classifyTelegramFailure(e)).toBe("transient");
  });

  it("types a chat the bot was kicked from as permanently gone", async () => {
    stubFetch(403, {
      ok: false,
      description: "Forbidden: bot was kicked from the supergroup chat",
    });
    const e = await editFailure();
    expect(e.status).toBe(403);
    expect(classifyTelegramFailure(e)).toBe("permanent");
  });

  it("types a network reach failure with no status at all", async () => {
    stubFetchThrowing(new TypeError("fetch failed"));
    const e = await editFailure();
    expect(e.status).toBeNull();
    expect(e.description).toBeNull();
    expect(e.message).toContain("fetch failed");
    expect(classifyTelegramFailure(e)).toBe("transient");
  });

  it("types a timeout the same way — the abort never reached an answer", async () => {
    stubFetchThrowing(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      )
    );
    const e = await editFailure();
    expect(e.status).toBeNull();
    expect(classifyTelegramFailure(e)).toBe("transient");
  });

  it("still swallows 'message is not modified' as success", async () => {
    // The desired state already holds, so the edit is a no-op rather than a failure —
    // unchanged by the typing, and matched on the message the typed error still carries.
    stubFetch(400, {
      ok: false,
      description: "Bad Request: message is not modified",
    });
    await expect(
      editMessageTextRaw("5551885", 42, "hello")
    ).resolves.toBeUndefined();
  });
});
