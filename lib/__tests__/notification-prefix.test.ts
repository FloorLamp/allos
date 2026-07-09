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
