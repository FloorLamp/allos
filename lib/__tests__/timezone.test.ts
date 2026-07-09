import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
} from "../timezone";

describe("isValidTimezone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
  });

  it("rejects empty and bogus zones", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });
});

describe("resolveTimezone", () => {
  it("prefers the per-profile setting over the instance default", () => {
    expect(resolveTimezone("America/Chicago", "Europe/London")).toBe(
      "America/Chicago"
    );
  });

  it("falls back to the instance default when the profile has none", () => {
    expect(resolveTimezone(undefined, "Europe/London")).toBe("Europe/London");
  });

  it("falls back to UTC when neither is set", () => {
    expect(resolveTimezone(undefined, undefined)).toBe(DEFAULT_TIMEZONE);
    expect(DEFAULT_TIMEZONE).toBe("UTC");
  });

  it("falls back to UTC when the resolved value is not a real zone", () => {
    expect(resolveTimezone("Not/AZone", "Europe/London")).toBe("UTC");
    expect(resolveTimezone(undefined, "bogus")).toBe("UTC");
  });
});
