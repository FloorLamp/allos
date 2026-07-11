import { describe, it, expect } from "vitest";
import {
  pickDispatchError,
  isDeliveryHealthy,
  decideMarker,
} from "../notifications/delivery-status";

describe("pickDispatchError", () => {
  it("returns null when every channel succeeded", () => {
    expect(
      pickDispatchError([
        { id: "telegram", ok: true },
        { id: "push", ok: true },
      ])
    ).toBeNull();
  });

  it("returns null when nothing was attempted (no configured channel)", () => {
    expect(pickDispatchError([])).toBeNull();
  });

  it("returns the first failed channel + its error", () => {
    expect(
      pickDispatchError([
        { id: "telegram", ok: false, error: "401 unauthorized" },
        { id: "push", ok: true },
      ])
    ).toEqual({ channel: "telegram", error: "401 unauthorized" });
  });

  it("reports a failure even when another channel succeeded", () => {
    // A partial failure still means a channel is broken → surface it.
    expect(
      pickDispatchError([
        { id: "push", ok: true },
        { id: "telegram", ok: false, error: "chat not found" },
      ])
    ).toEqual({ channel: "telegram", error: "chat not found" });
  });

  it("falls back to a generic message when the error string is missing", () => {
    expect(pickDispatchError([{ id: "telegram", ok: false }])).toEqual({
      channel: "telegram",
      error: "unknown send failure",
    });
  });
});

describe("isDeliveryHealthy", () => {
  it("is true only when at least one channel was attempted and all succeeded", () => {
    expect(isDeliveryHealthy([{ id: "telegram", ok: true }])).toBe(true);
    expect(
      isDeliveryHealthy([
        { id: "telegram", ok: true },
        { id: "push", ok: true },
      ])
    ).toBe(true);
  });

  it("is false when a channel failed", () => {
    expect(
      isDeliveryHealthy([
        { id: "telegram", ok: false, error: "boom" },
        { id: "push", ok: true },
      ])
    ).toBe(false);
  });

  it("is false when nothing was attempted (clears nothing)", () => {
    expect(isDeliveryHealthy([])).toBe(false);
  });
});

describe("decideMarker (channel-aware clearing, #192)", () => {
  it("sets the failure when a channel failed (no prior marker)", () => {
    expect(
      decideMarker([{ id: "push", ok: false, error: "bad VAPID" }], "")
    ).toEqual({
      action: "set",
      failure: { channel: "push", error: "bad VAPID" },
    });
  });

  it("keeps the marker untouched when nothing was attempted", () => {
    expect(decideMarker([], "push")).toEqual({ action: "keep" });
  });

  // --- Cross-profile tick: push broken globally, Telegram works. ---

  it("A: a both-channels profile with a broken push SETS the push failure", () => {
    // Profile A dispatches Telegram (ok) + push (fails) → record push.
    expect(
      decideMarker(
        [
          { id: "telegram", ok: true },
          { id: "push", ok: false, error: "bad VAPID" },
        ],
        ""
      )
    ).toEqual({
      action: "set",
      failure: { channel: "push", error: "bad VAPID" },
    });
  });

  it("B: a Telegram-only profile does NOT clear a push failure it never attempted", () => {
    // Profile B (Telegram only) succeeds later in the same tick — push is still
    // broken and was not attempted, so the marker must survive.
    expect(decideMarker([{ id: "telegram", ok: true }], "push")).toEqual({
      action: "keep",
    });
  });

  it("a later successful push DOES clear the push failure", () => {
    // Once push is fixed, a dispatch that attempts push and succeeds clears it.
    expect(
      decideMarker(
        [
          { id: "telegram", ok: true },
          { id: "push", ok: true },
        ],
        "push"
      )
    ).toEqual({ action: "clear" });
  });

  it("clears when a single-channel healthy dispatch attempts the failing channel", () => {
    // Send-test remediation: the broken channel is the one tested successfully.
    expect(decideMarker([{ id: "telegram", ok: true }], "telegram")).toEqual({
      action: "clear",
    });
  });

  it("keeps a telegram failure when only push is attempted successfully", () => {
    // Symmetric to the push case: a push-only success must not mask a broken
    // Telegram.
    expect(decideMarker([{ id: "push", ok: true }], "telegram")).toEqual({
      action: "keep",
    });
  });

  it("clears on any healthy dispatch when the prior channel is unknown (legacy marker)", () => {
    // A marker written before channel tracking has no stored channel; fall back
    // to the original clear-on-healthy behavior.
    expect(decideMarker([{ id: "telegram", ok: true }], "")).toEqual({
      action: "clear",
    });
  });

  // --- Home Assistant channel (#248): the marker is channel-agnostic, so the same
  // channel-aware clearing rules must hold for a third channel id. ---

  it("HA: sets a home-assistant failure like any other channel", () => {
    expect(
      decideMarker(
        [
          { id: "telegram", ok: true },
          { id: "home-assistant", ok: false, error: "HTTP 404" },
        ],
        ""
      )
    ).toEqual({
      action: "set",
      failure: { channel: "home-assistant", error: "HTTP 404" },
    });
  });

  it("HA: a Telegram-only profile does NOT clear a home-assistant failure it never attempted", () => {
    expect(
      decideMarker([{ id: "telegram", ok: true }], "home-assistant")
    ).toEqual({ action: "keep" });
  });

  it("HA: a later successful home-assistant send clears the home-assistant failure", () => {
    expect(
      decideMarker([{ id: "home-assistant", ok: true }], "home-assistant")
    ).toEqual({ action: "clear" });
  });

  it("overwrites an existing failure with a newly-failing channel", () => {
    // push was broken; now push is ok but telegram fails → record telegram.
    expect(
      decideMarker(
        [
          { id: "telegram", ok: false, error: "chat not found" },
          { id: "push", ok: true },
        ],
        "push"
      )
    ).toEqual({
      action: "set",
      failure: { channel: "telegram", error: "chat not found" },
    });
  });
});
