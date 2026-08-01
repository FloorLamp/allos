// PURE TIER (#1779) — the reconcile decision and the keyboard surgery it does.
//
// The invariant every case here defends: reconciliation only ever REDUCES what a chat
// claims, it makes NO call when nothing changed, and it never closes a message on the
// strength of a button nobody has reasoned about.

import { describe, it, expect } from "vitest";
import {
  decideReconcile,
  keyboardTokens,
  RECONCILE_CLOSING,
  stripTokens,
  tokenPrefix,
} from "@/lib/notifications/reconcile-core";
import type { InlineKeyboard } from "@/lib/notifications/telegram-render";

const DATE = "2020-03-04";

function kb(...rows: string[][]): InlineKeyboard {
  return rows.map((row) =>
    row.map((token) => ({ text: token, callback_data: token }))
  );
}

const TAKE_A = `take:7:11:3:${DATE}`;
const TAKE_B = `take:7:12:3:${DATE}`;
const SKIP_A = `skip:7:11:3:${DATE}`;
const TUNE = `tune:7:${DATE}`;

describe("tokenPrefix", () => {
  it("reads the prefix of a callback token", () => {
    expect(tokenPrefix(TAKE_A)).toBe("take");
    expect(tokenPrefix("hh:1:2:3:4:2020-03-04")).toBe("hh");
  });

  it("has no prefix for a url button, an empty token or a colonless one", () => {
    expect(tokenPrefix(undefined)).toBeNull();
    expect(tokenPrefix("")).toBeNull();
    expect(tokenPrefix(":leading")).toBeNull();
    expect(tokenPrefix("nocolon")).toBeNull();
  });
});

describe("keyboardTokens", () => {
  it("reads every callback token in keyboard order", () => {
    expect(keyboardTokens(kb([TAKE_A, SKIP_A], [TAKE_B]))).toEqual([
      TAKE_A,
      SKIP_A,
      TAKE_B,
    ]);
  });

  it("ignores deep-link buttons — a url carries no claim", () => {
    const keyboard: InlineKeyboard = [
      [
        { text: "Open", url: "https://example.invalid/x" },
        { text: "t", callback_data: TAKE_A },
      ],
    ];
    expect(keyboardTokens(keyboard)).toEqual([TAKE_A]);
  });
});

describe("stripTokens", () => {
  it("removes named buttons and collapses rows left empty", () => {
    const out = stripTokens(
      kb([TAKE_A, SKIP_A], [TAKE_B]),
      new Set([TAKE_A, SKIP_A])
    );
    expect(out).toHaveLength(1);
    expect(keyboardTokens(out)).toEqual([TAKE_B]);
  });

  it("never removes a deep-link button", () => {
    const keyboard: InlineKeyboard = [
      [{ text: "Open", url: "https://example.invalid/x" }],
      [{ text: "t", callback_data: TAKE_A }],
    ];
    const out = stripTokens(keyboard, new Set([TAKE_A]));
    expect(out).toEqual([[{ text: "Open", url: "https://example.invalid/x" }]]);
  });
});

describe("decideReconcile — the steady state", () => {
  it("makes NO call when nothing resolved (the rate-limit pin)", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A, TAKE_B]),
        dead: new Set(),
        inert: new Set(),
        rolledOver: false,
      })
    ).toEqual({ action: "none" });
  });

  it("makes NO call for a keyboard of purely inert controls", () => {
    expect(
      decideReconcile({
        keyboard: kb([TUNE]),
        dead: new Set(),
        inert: new Set([TUNE]),
        rolledOver: false,
      })
    ).toEqual({ action: "none" });
  });

  it("leaves an UNRECOGNIZED keyboard alone — failing safe, never closing blind", () => {
    // No family claimed these tokens, so `dead` is empty: the message survives intact
    // rather than being closed on a guess.
    expect(
      decideReconcile({
        keyboard: kb(["mystery:1:2"]),
        dead: new Set(),
        inert: new Set(),
        rolledOver: false,
      })
    ).toEqual({ action: "none" });
  });
});

describe("decideReconcile — partial and full resolution", () => {
  it("strips only the resolved buttons when others remain", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A, SKIP_A], [TAKE_B]),
      dead: new Set([TAKE_A, SKIP_A]),
      inert: new Set(),
      rolledOver: false,
    });
    expect(d.action).toBe("strip");
    if (d.action !== "strip") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toEqual([TAKE_B]);
  });

  it("closes when every CLAIM is resolved", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A], [TAKE_B]),
        dead: new Set([TAKE_A, TAKE_B]),
        inert: new Set(),
        rolledOver: false,
      })
    ).toEqual({ action: "close", reason: "resolved" });
  });

  it("an INERT control does not keep a fully resolved message alive", () => {
    // The digest's ⚙️ Tune and the offer tail ride other messages; they must not make a
    // resolved dose reminder look outstanding forever.
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A], [TUNE]),
        dead: new Set([TAKE_A]),
        inert: new Set([TUNE]),
        rolledOver: false,
      })
    ).toEqual({ action: "close", reason: "resolved" });
  });

  it("an inert control is never itself reported dead", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A, TUNE], [TAKE_B]),
      dead: new Set([TAKE_A, TUNE]),
      inert: new Set([TUNE]),
      rolledOver: false,
    });
    expect(d.action).toBe("strip");
    if (d.action !== "strip") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toContain(TUNE);
  });
});

describe("decideReconcile — day rollover", () => {
  it("closes yesterday's message outright when every button is a claim", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A, TAKE_B]),
        dead: new Set(),
        inert: new Set(),
        rolledOver: true,
      })
    ).toEqual({ action: "close", reason: "rollover" });
  });

  it("rollover wins over per-token state — an unresolved claim still goes", () => {
    // Yesterday's tokens carry yesterday's date and the handlers refuse them anyway;
    // leaving them tappable is worse than removing them. This is also the residual
    // #947 gap: the last nudge of an evening used to stay live until the NEXT send.
    const d = decideReconcile({
      keyboard: kb([TAKE_A]),
      dead: new Set(),
      inert: new Set(),
      rolledOver: true,
    });
    expect(d).toEqual({ action: "close", reason: "rollover" });
  });

  it("keeps inert controls when rolling over a mixed keyboard", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A], [TUNE]),
      dead: new Set(),
      inert: new Set([TUNE]),
      rolledOver: true,
    });
    expect(d.action).toBe("strip-all");
    if (d.action !== "strip-all") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toEqual([TUNE]);
  });

  it("a rolled-over keyboard with nothing but inert controls needs no call", () => {
    expect(
      decideReconcile({
        keyboard: kb([TUNE]),
        dead: new Set(),
        inert: new Set([TUNE]),
        rolledOver: true,
      })
    ).toEqual({ action: "none" });
  });
});

describe("the closing lines", () => {
  it("say WHY the buttons are gone, without celebrating or judging", () => {
    expect(RECONCILE_CLOSING.resolved).toContain("app");
    expect(RECONCILE_CLOSING.rollover).toContain("yesterday");
  });
});
