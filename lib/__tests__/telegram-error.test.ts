// PURE TIER (#1885) — the one decision that says whether a failed Telegram edit means
// the message is gone for good or merely that this attempt did not land.
//
// The harm behind it: the reconcile sweep claims a pointer BEFORE it calls the Bot API,
// so a wrongly-"permanent" verdict drops the only record of what a live chat is showing
// and no future tick can ever correct that keyboard. Every case below is therefore a
// claim about which side of that line a real Telegram answer falls on.

import { describe, expect, it } from "vitest";
import {
  classifyTelegramFailure,
  TelegramApiError,
} from "@/lib/notifications/telegram-error";

// A typed throw as ./telegram-api builds it: the message always carries the description
// (or the HTTP status when Telegram gave none), which is what the mocked/legacy shapes
// below rely on too.
function apiError(
  status: number | null,
  description: string | null,
  method = "editMessageText"
): TelegramApiError {
  return new TelegramApiError({
    method,
    status,
    description,
    message: `Telegram ${method} failed: ${description ?? `HTTP ${status}`}`,
  });
}

describe("permanently dead messages", () => {
  // Telegram's real descriptions for a message nothing can ever edit again.
  const permanent = [
    "message to edit not found",
    "message can't be edited",
    "MESSAGE_ID_INVALID",
    "Bad Request: chat not found",
    "Forbidden: bot was kicked from the group chat",
    "Forbidden: bot was blocked by the user",
    "Forbidden: bot is not a member of the supergroup chat",
    "Forbidden: user is deactivated",
    "Bad Request: CHAT_WRITE_FORBIDDEN",
    "Bad Request: PEER_ID_INVALID",
    "Bad Request: group chat was upgraded to a supergroup chat",
  ];

  it.each(permanent)("%s is permanent", (description) => {
    expect(classifyTelegramFailure(apiError(400, description))).toBe(
      "permanent"
    );
  });

  it("a 403 is permanent even with a description we do not recognise", () => {
    expect(
      classifyTelegramFailure(apiError(403, "Forbidden: something new"))
    ).toBe("permanent");
  });

  it("reads the description out of a PLAIN Error too", () => {
    // The shape a mocked transport (and any pre-#1885 throw) produces: no structure,
    // description embedded in the sentence.
    expect(
      classifyTelegramFailure(
        new Error("Telegram editMessageText failed: message to edit not found")
      )
    ).toBe("permanent");
  });

  it("recovers the status from a plain Error's HTTP tail", () => {
    expect(
      classifyTelegramFailure(
        new Error("Telegram editMessageText failed: HTTP 403")
      )
    ).toBe("permanent");
  });
});

describe("failures that only mean 'not this time'", () => {
  it("a 429 rate limit is transient", () => {
    expect(
      classifyTelegramFailure(
        apiError(429, "Too Many Requests: retry after 30")
      )
    ).toBe("transient");
  });

  it.each([500, 502, 503, 504])("a %i is transient", (status) => {
    expect(classifyTelegramFailure(apiError(status, null))).toBe("transient");
  });

  it("a network reach failure (no status at all) is transient", () => {
    expect(
      classifyTelegramFailure(
        new TelegramApiError({
          method: "editMessageText",
          status: null,
          description: null,
          message: "Telegram editMessageText failed: fetch failed",
          cause: new TypeError("fetch failed"),
        })
      )
    ).toBe("transient");
  });

  it("an abort/timeout is transient", () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );
    expect(
      classifyTelegramFailure(
        new TelegramApiError({
          method: "editMessageText",
          status: null,
          description: null,
          message: `Telegram editMessageText failed: ${timeout.message}`,
          cause: timeout,
        })
      )
    ).toBe("transient");
    // …and the raw abort, should one ever escape untyped.
    expect(classifyTelegramFailure(timeout)).toBe("transient");
  });

  it("a missing bot token is transient — a config gap is not a dead message", () => {
    // The one throw that never reaches the wire. Dropping every pointer because the
    // token was momentarily unset would be the worst possible reading of it.
    expect(
      classifyTelegramFailure(new Error("Telegram bot token is not configured"))
    ).toBe("transient");
  });
});

describe("the unknown-failure default", () => {
  // DELIBERATE, and the asymmetry is the whole argument: a wrong "permanent" drops the
  // pointer with no retry path left (a live chat keeps a lying keyboard forever), while
  // a wrong "transient" costs at most one cheap failing call per tick until the pointer
  // ages out at MESSAGE_POINTER_RETENTION_DAYS. Bounded by retention, not by a counter.
  it("an unrecognised Telegram description is transient", () => {
    expect(
      classifyTelegramFailure(
        apiError(400, "Bad Request: some future condition")
      )
    ).toBe("transient");
  });

  it("a non-Error throw is transient", () => {
    expect(classifyTelegramFailure("kaboom")).toBe("transient");
    expect(classifyTelegramFailure(undefined)).toBe("transient");
  });
});

describe("the typed error carries what classification reads", () => {
  it("keeps status, description and method addressable", () => {
    const e = apiError(
      429,
      "Too Many Requests: retry after 5",
      "editMessageReplyMarkup"
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(429);
    expect(e.description).toBe("Too Many Requests: retry after 5");
    expect(e.method).toBe("editMessageReplyMarkup");
    // The message wording is unchanged from the pre-#1885 format — the tick logs it and
    // telegram-api's own "message is not modified" guard matches on it.
    expect(e.message).toBe(
      "Telegram editMessageReplyMarkup failed: Too Many Requests: retry after 5"
    );
  });
});
