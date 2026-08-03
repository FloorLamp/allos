// PURE TIER — the food-nudge "last sent message" pointer (#947): the serialize/parse
// round-trip stored in profile_settings and the extraction of a pointer from an
// outbound nudge message. The DB rotation (strip previous keyboard, store new
// pointer) is covered end-to-end in lib/__db_tests__/food-nudge-close.test.ts.

import { describe, it, expect } from "vitest";
import {
  serializeFoodNudgePointer,
  parseFoodNudgePointer,
  foodNudgePointerFromMessage,
  type FoodNudgePointer,
} from "@/lib/notifications/food-nudge-pointer";
import type { NotificationMessage } from "@/lib/notifications/types";

describe("food nudge pointer round-trip", () => {
  it("survives serialize → parse unchanged (numeric chat id)", () => {
    const p: FoodNudgePointer = {
      chatId: 5550100,
      messageId: 77,
      date: "2026-07-18",
      window: "Morning",
    };
    expect(parseFoodNudgePointer(serializeFoodNudgePointer(p))).toEqual(p);
  });

  it("survives serialize → parse unchanged (string chat id)", () => {
    const p: FoodNudgePointer = {
      chatId: "-1005550299",
      messageId: 12,
      date: "2026-07-18",
      window: "Evening",
    };
    expect(parseFoodNudgePointer(serializeFoodNudgePointer(p))).toEqual(p);
  });

  it("parses null/absent/garbage to null (never throws on the send path)", () => {
    expect(parseFoodNudgePointer(null)).toBeNull();
    expect(parseFoodNudgePointer(undefined)).toBeNull();
    expect(parseFoodNudgePointer("")).toBeNull();
    expect(parseFoodNudgePointer("not json")).toBeNull();
    expect(parseFoodNudgePointer("[]")).toBeNull();
    expect(parseFoodNudgePointer("42")).toBeNull();
  });

  it("rejects a structurally-invalid pointer (missing/bad fields)", () => {
    expect(parseFoodNudgePointer(JSON.stringify({ messageId: 1 }))).toBeNull();
    expect(
      parseFoodNudgePointer(
        JSON.stringify({
          chatId: 1,
          messageId: "x",
          date: "2026-07-18",
          window: "Morning",
        })
      )
    ).toBeNull();
    expect(
      parseFoodNudgePointer(
        JSON.stringify({
          chatId: 1,
          messageId: 1,
          date: "bad",
          window: "Morning",
        })
      )
    ).toBeNull();
    expect(
      parseFoodNudgePointer(
        JSON.stringify({
          chatId: 1,
          messageId: 1,
          date: "2026-07-18",
          window: "Bedtime",
        })
      )
    ).toBeNull();
  });
});

describe("foodNudgePointerFromMessage", () => {
  const nudge: NotificationMessage = {
    title: "🍽️ Morning food log",
    body: "…",
    kind: "food",
    actions: [
      {
        label: "Leafy greens",
        data: "food:5:Morning:2026-07-18:leafy_greens",
        row: "food0",
      },
      {
        label: "Berries",
        data: "food:5:Morning:2026-07-18:berries",
        row: "food0",
      },
      {
        label: "➕ Show more",
        data: "foodmore:5:Morning:2026-07-18",
        row: "food-showmore",
      },
    ],
  };

  it("reads window + date from the first quick-log button", () => {
    expect(foodNudgePointerFromMessage(nudge, 5550100, 88)).toEqual({
      chatId: 5550100,
      messageId: 88,
      date: "2026-07-18",
      window: "Morning",
    });
  });

  it("returns null when no food quick-log button is present", () => {
    const buttonless: NotificationMessage = {
      title: "x",
      body: "y",
      kind: "food",
      // A view control only — no ranked button, so there is no window/date to point at.
      actions: [
        {
          label: "➖ Show less",
          data: "foodless:5:Morning:2026-07-18",
          row: "food-showmore",
        },
      ],
    };
    expect(foodNudgePointerFromMessage(buttonless, 1, 1)).toBeNull();
    expect(
      foodNudgePointerFromMessage({ title: "x", body: "y", kind: "food" }, 1, 1)
    ).toBeNull();
  });

  // The pointer describes what the CHAT IS SHOWING, so it must be read off the
  // delivered (post-cap) keyboard, not the pre-cap `msg.actions` (#1945). A quick-log
  // row the button cap dropped never reached the chat, so it cannot justify a pointer
  // — otherwise the next send strips a message on the strength of buttons nobody has.
  // The shape below is synthetic (a real nudge carries ~8 buttons); the rule is not.
  it("ignores a quick-log button dropped by the 100-button cap", () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      label: `f${i}`,
      data: `foodmore:5:Morning:2026-07-18`,
      row: `r${i}`,
    }));
    const capped: NotificationMessage = {
      title: "🍽️ Morning food log",
      body: "…",
      kind: "food",
      actions: [
        ...filler,
        {
          label: "Leafy greens",
          data: "food:5:Morning:2026-07-18:leafy_greens",
          row: "food0",
        },
      ],
    };
    expect(foodNudgePointerFromMessage(capped, 5550100, 88)).toBeNull();
  });

  it("still reads a quick-log button that fits under the cap", () => {
    const filler = Array.from({ length: 98 }, (_, i) => ({
      label: `f${i}`,
      data: `foodmore:5:Morning:2026-07-18`,
      row: `r${i}`,
    }));
    const fits: NotificationMessage = {
      title: "🍽️ Morning food log",
      body: "…",
      kind: "food",
      actions: [
        ...filler,
        {
          label: "Leafy greens",
          data: "food:5:Morning:2026-07-18:leafy_greens",
          row: "food0",
        },
      ],
    };
    expect(foodNudgePointerFromMessage(fits, 5550100, 88)).toEqual({
      chatId: 5550100,
      messageId: 88,
      date: "2026-07-18",
      window: "Morning",
    });
  });
});
