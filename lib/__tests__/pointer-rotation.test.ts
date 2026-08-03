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

// ── ONE LIVE KEYBOARD PER (chat, kind) — issue #1898 ─────────────────────────
//
// The rotation above keys on a pointer the OUTGOING message yields. The generalization
// keys on the pointer TABLE instead, so a kind with no identifying token of its own
// (`/dose`, `/symptom`, and #1895's commands) gets the same single-live invariant. The
// end-to-end write path is covered in lib/__db_tests__/kind-supersede.test.ts.

import { planKindSupersede } from "@/lib/notifications/pointer-rotation";

type P = { chatId: string | number; messageId: number; kind: string };
const REISSUABLE = (k: string) => k === "prn-list" || k === "symptom";
const at = (
  messageId: number,
  kind: string,
  chatId: string | number = CHAT
): P => ({ chatId, messageId, kind });

describe("planKindSupersede (#1898)", () => {
  it("a second send of a re-issuable kind supersedes the first", () => {
    expect(
      planKindSupersede([at(10, "prn-list")], at(11, "prn-list"), REISSUABLE)
    ).toEqual([at(10, "prn-list")]);
  });

  it("the first send of a kind supersedes nothing", () => {
    expect(planKindSupersede([], at(11, "prn-list"), REISSUABLE)).toEqual([]);
  });

  it("a kind that did NOT declare itself re-issuable closes nothing", () => {
    // Two dose reminders are two outstanding claims — the morning session and the
    // evening one — and closing either would remove a safety prompt nobody answered.
    expect(
      planKindSupersede([at(10, "dose")], at(11, "dose"), REISSUABLE)
    ).toEqual([]);
  });

  it("never reaches across kinds", () => {
    expect(
      planKindSupersede(
        [at(10, "symptom"), at(11, "dose")],
        at(12, "symptom"),
        REISSUABLE
      )
    ).toEqual([at(10, "symptom")]);
  });

  it("never reaches across CHATS — a fan-out copy is not a duplicate", () => {
    // One profile's message goes to the family group AND a caregiver's private chat.
    // Re-issuing into the group must not close the caregiver's copy.
    const other = "-1005550299";
    expect(
      planKindSupersede(
        [at(10, "symptom", other), at(11, "symptom")],
        at(12, "symptom"),
        REISSUABLE
      )
    ).toEqual([at(11, "symptom")]);
  });

  it("compares chat ids across the string/number boundary", () => {
    expect(
      planKindSupersede(
        [at(10, "symptom", "5550100")],
        at(11, "symptom", 5550100),
        REISSUABLE
      )
    ).toEqual([at(10, "symptom", "5550100")]);
  });

  it("a send that recorded no pointer supersedes nothing", () => {
    // The symmetry that makes #1945's stranding class unrepresentable: no record, no
    // strip. A message with no delivered keyboard has replaced nothing.
    expect(planKindSupersede([at(10, "prn-list")], null, REISSUABLE)).toEqual(
      []
    );
  });

  it("a delivery the chat already holds cannot close itself", () => {
    expect(
      planKindSupersede([at(10, "prn-list")], at(10, "prn-list"), REISSUABLE)
    ).toEqual([]);
  });

  it("closes EVERY earlier live copy, not just the newest", () => {
    // The invariant is "one", not "one more than last time": a chat that accumulated
    // duplicates before this shipped converges on the next send rather than shedding
    // one per call.
    expect(
      planKindSupersede(
        [at(10, "prn-list"), at(11, "prn-list"), at(12, "prn-list")],
        at(13, "prn-list"),
        REISSUABLE
      )
    ).toEqual([at(10, "prn-list"), at(11, "prn-list"), at(12, "prn-list")]);
  });
});
