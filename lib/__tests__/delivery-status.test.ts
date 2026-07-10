import { describe, it, expect } from "vitest";
import {
  pickDispatchError,
  isDeliveryHealthy,
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
