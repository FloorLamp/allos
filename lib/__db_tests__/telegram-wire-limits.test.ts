// DB INTEGRATION TIER (#379) — the button cap on the WIRE, for both outbound
// directions, with only `fetch` stubbed so the guarded primitives themselves run.
//
// The harm this pins shut: `sendMessageRaw` guards Telegram's ~100-button limit and says
// it does so "in ONE place so every message builder is covered". That was true of sends
// only — an edit took a pre-built keyboard and passed it straight through. So the very
// regimen the cap exists for (thirty-odd scheduled doses in one merged reminder) got a
// correctly-capped send and then had every later tap rebuild the same oversized keyboard
// and be REJECTED, freezing the message on its pre-tap state. A cap on one side of a
// round trip is not a cap.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { setTelegramBotConfig } from "@/lib/settings";
import {
  editMessageTextRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import {
  TELEGRAM_MAX_BUTTONS,
  TELEGRAM_MESSAGE_LIMIT,
} from "@/lib/notifications/telegram-limits";
import type { NotificationMessage } from "@/lib/notifications/types";

const OVER = TELEGRAM_MAX_BUTTONS + 20;
let bodies: Record<string, unknown>[] = [];
let priorFetch: typeof globalThis.fetch;

beforeEach(() => {
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
  bodies = [];
  priorFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    } as never;
  }) as never;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
});

// One button per row, so the cap's whole-rows rule drops exactly the overflow.
function oversized(): NotificationMessage {
  return {
    title: "💊 Morning supplements",
    body: "a big regimen",
    actions: Array.from({ length: OVER }, (_, i) => ({
      label: `Item ${i}`,
      data: `take:1:${i}:${i}:2026-08-05`,
    })),
    kind: "dose",
  };
}

function buttonsOf(body: Record<string, unknown>): number {
  const markup = body.reply_markup as
    { inline_keyboard?: unknown[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().length;
}

describe("the ~100-button cap applies to an EDIT, not only a send (#379)", () => {
  it("caps both directions to the same count and names what it dropped", async () => {
    const msg = oversized();

    await sendMessageRaw("5550001", msg);
    const sent = bodies.at(-1)!;
    expect(buttonsOf(sent)).toBe(TELEGRAM_MAX_BUTTONS);
    expect(String(sent.text)).toContain(`+${OVER - TELEGRAM_MAX_BUTTONS} more`);

    // The rebuild hands over the SAME uncapped keyboard the builder produced — which is
    // exactly what a tap on a capped session does.
    bodies = [];
    await editMessageTextRaw("5550001", 42, "<b>💊 Morning supplements</b>", {
      keyboard: messageKeyboard(msg),
      parseMode: "HTML",
    });
    const edited = bodies.at(-1)!;
    expect(buttonsOf(edited)).toBe(TELEGRAM_MAX_BUTTONS);
    expect(String(edited.text)).toContain(
      `+${OVER - TELEGRAM_MAX_BUTTONS} more`
    );
  });

  it("leaves a keyboard under the cap untouched, and adds no overflow line", async () => {
    // The steady state: no note appears on the ordinary reminder, and the edit still
    // always sets reply_markup so a resolved session can drop its buttons.
    await editMessageTextRaw("5550001", 42, "plain", {
      keyboard: [
        [{ text: "✅ Taken", callback_data: "take:1:2:3:2026-08-05" }],
      ],
    });
    const body = bodies.at(-1)!;
    expect(buttonsOf(body)).toBe(1);
    expect(String(body.text)).toBe("plain");

    bodies = [];
    await editMessageTextRaw("5550001", 42, "closed", {});
    expect(buttonsOf(bodies.at(-1)!)).toBe(0);
  });
});

describe("an edit shortens an oversized body rather than failing (#379)", () => {
  it("cuts on a line boundary, says so, and keeps the buttons", async () => {
    // A send SPLITS; an edit has one message and no way to grow it. Failing would leave
    // the message showing its PRE-TAP keyboard — the #1779 harm, a chat still presenting
    // a confirmed dose as outstanding.
    const line = "• Something reasonably long on its own line";
    const huge = Array.from({ length: 200 }, () => line).join("\n");
    expect(huge.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    await editMessageTextRaw("5550001", 42, huge, {
      keyboard: [
        [{ text: "✅ Taken", callback_data: "take:1:2:3:2026-08-05" }],
      ],
      parseMode: "HTML",
    });
    const body = bodies.at(-1)!;
    const sent = String(body.text);
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(sent).toContain("Shortened");
    // Cut between lines, never mid-line — a half-written tag would be rejected outright.
    expect(sent.split("\n").filter((l) => l.startsWith("•"))).toSatisfy(
      (kept: string[]) => kept.every((l) => l === line)
    );
    // The buttons are what the message is FOR, and they carry the sweep's state claim.
    expect(buttonsOf(body)).toBe(1);
  });

  it("leaves a body under the limit exactly as given", async () => {
    await editMessageTextRaw("5550001", 42, "<b>💊 Morning</b>\n• One", {});
    expect(String(bodies.at(-1)!.text)).toBe("<b>💊 Morning</b>\n• One");
  });
});
