import { describe, it, expect } from "vitest";
import {
  profileMessagePrefix,
  prefixMessage,
  type NotificationMessage,
} from "../notifications/types";

describe("profileMessagePrefix", () => {
  it("is empty on a single-profile instance", () => {
    expect(profileMessagePrefix("Alex", 1)).toBe("");
  });

  it("names the profile when the instance has more than one", () => {
    expect(profileMessagePrefix("Alex", 2)).toBe("[Alex] ");
  });

  it("is empty when the name is blank even with multiple profiles", () => {
    expect(profileMessagePrefix("", 3)).toBe("");
  });
});

describe("prefixMessage", () => {
  const msg: NotificationMessage = {
    title: "💊 Morning supplements",
    body: "…",
  };

  it("prepends the prefix to the title only", () => {
    expect(prefixMessage(msg, "[Alex] ")).toEqual({
      title: "[Alex] 💊 Morning supplements",
      body: "…",
    });
  });

  it("returns the message unchanged for an empty prefix", () => {
    expect(prefixMessage(msg, "")).toBe(msg);
  });

  it("preserves actions", () => {
    const withActions: NotificationMessage = {
      ...msg,
      actions: [{ label: "✅ D3", data: "take:1:2:3:2026-07-03" }],
    };
    expect(prefixMessage(withActions, "[Alex] ").actions).toEqual(
      withActions.actions
    );
  });
});

// The Telegram tap-rebuild paths (handleDoseTap / handleAllTaken) re-render a
// session message from scratch and must re-apply the SAME send-time prefix
// (prefixForProfile → profileMessagePrefix → prefixMessage), or a shared-chat
// reminder collapses to an unattributable title after a button tap — a parent
// could confirm the wrong child's doses (issue #377). This pins that the rebuild
// composition (the pure half) still labels the title with live buttons attached.
describe("rebuild keeps the profile prefix (issue #377)", () => {
  const rebuilt: NotificationMessage = {
    title: "💊 Morning supplements",
    body: "D3 · Magnesium",
    actions: [
      { label: "✅ D3", data: "take:2:12:34:2026-07-03", row: "d12" },
      { label: "⏭", data: "skip:2:12:34:2026-07-03", row: "d12" },
      { label: "✅ All (2)", data: "all:2:Morning:2026-07-03" },
    ],
  };

  it("labels a rebuilt multi-profile message and keeps its buttons", () => {
    const out = prefixMessage(rebuilt, profileMessagePrefix("Ada", 2));
    expect(out.title).toBe("[Ada] 💊 Morning supplements");
    expect(out.actions).toEqual(rebuilt.actions); // live buttons survive
  });

  it("keeps two family members' rebuilt messages distinguishable", () => {
    const ada = prefixMessage(rebuilt, profileMessagePrefix("Ada", 2)).title;
    const ben = prefixMessage(rebuilt, profileMessagePrefix("Ben", 2)).title;
    expect(ada).not.toBe(ben);
  });

  it("adds no label on a single-profile instance (unchanged rebuild)", () => {
    expect(prefixMessage(rebuilt, profileMessagePrefix("Ada", 1))).toBe(
      rebuilt
    );
  });
});
