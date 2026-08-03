// PURE TIER — the "one live keyboard per pointer" rotation ordering (#1945).
//
// The rotation performs two writes that must agree: strip the keyboard of the message
// the pointer names, and record the just-sent message as the new pointer. Before #1945
// the food rotation performed them under DIFFERENT conditions, so a send whose
// extraction returned null stripped its predecessor and recorded nothing — the pointer
// went on naming an already-stripped message and the new one kept a live keyboard
// forever. These cases pin the decision that makes that unrepresentable.
//
// The end-to-end write path is covered in lib/__db_tests__/food-nudge-close.test.ts.

import { describe, it, expect } from "vitest";
import {
  planPointerRotation,
  samePointerTarget,
  type PointerRotation,
  type PointerTarget,
} from "@/lib/notifications/pointer-rotation";

const CHAT = 5550100;

describe("planPointerRotation", () => {
  it("records without stripping when there is no previous pointer", () => {
    const plan = planPointerRotation(null, {
      chatId: CHAT,
      messageId: 10,
    });
    expect(plan).toEqual({
      action: "rotate",
      record: { chatId: CHAT, messageId: 10 },
      strip: null,
    });
  });

  it("strips the previous message and records the new one", () => {
    const prev: PointerTarget = { chatId: CHAT, messageId: 10 };
    const plan = planPointerRotation(prev, { chatId: CHAT, messageId: 11 });
    expect(plan).toEqual({
      action: "rotate",
      record: { chatId: CHAT, messageId: 11 },
      strip: prev,
    });
  });

  it("never strips the message it is about to record (chat id type-blind)", () => {
    // The stored pointer keeps the chat id as Telegram reported it; the send path may
    // hold the other representation of the same chat.
    const plan = planPointerRotation(
      { chatId: "5550100", messageId: 10 },
      { chatId: CHAT, messageId: 10 }
    );
    expect(plan).toEqual({
      action: "rotate",
      record: { chatId: CHAT, messageId: 10 },
      strip: null,
    });
  });

  // THE PIN. A send that yields no pointer must not strip: it has superseded nothing.
  // Stripping here is what stranded the pointer on an already-closed message and left
  // the new one holding a live keyboard nothing would ever close.
  it("skips entirely — no strip — when the send yields no pointer", () => {
    const prev: PointerTarget = { chatId: CHAT, messageId: 10 };
    expect(planPointerRotation(prev, null)).toEqual({ action: "skip" });
    expect(planPointerRotation(prev, undefined)).toEqual({ action: "skip" });
    expect(planPointerRotation(null, null)).toEqual({ action: "skip" });
  });

  it("strip and record are inseparable across a run of sends", () => {
    // Three consecutive sends, the middle one extracting to null (a keyboard carrying
    // only view controls / the protein button — no food-group token). Fold the plans
    // the way the executor does: record first, then strip.
    const sends: (PointerTarget | null)[] = [
      { chatId: CHAT, messageId: 1 },
      null,
      { chatId: CHAT, messageId: 3 },
    ];
    let pointer: PointerTarget | null = null;
    const stripped: number[] = [];
    for (const next of sends) {
      const prev: PointerTarget | null = pointer;
      const plan: PointerRotation<PointerTarget> = planPointerRotation(
        next ? prev : null,
        next
      );
      if (plan.action === "skip") continue;
      pointer = plan.record;
      if (plan.strip) stripped.push(plan.strip.messageId);
    }
    // Message 1 is stripped by message 3 — the one that actually superseded it. The
    // middle send stripped nothing, and the pointer names the newest EXTRACTABLE
    // message at the end rather than a message already closed.
    expect(stripped).toEqual([1]);
    expect(pointer).toEqual({ chatId: CHAT, messageId: 3 });
  });
});

describe("samePointerTarget", () => {
  it("compares chat ids across string/number representations", () => {
    expect(
      samePointerTarget(
        { chatId: "-1005550299", messageId: 7 },
        { chatId: -1005550299, messageId: 7 }
      )
    ).toBe(true);
    expect(
      samePointerTarget(
        { chatId: 1, messageId: 7 },
        { chatId: 1, messageId: 8 }
      )
    ).toBe(false);
    expect(
      samePointerTarget(
        { chatId: 1, messageId: 7 },
        { chatId: 2, messageId: 7 }
      )
    ).toBe(false);
  });
});
