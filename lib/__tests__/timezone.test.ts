import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  formatTimezoneOffset,
  isValidTimezone,
  resolveTimezone,
  timezoneOffsetMinutes,
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

describe("timezone offsets", () => {
  it("formats current offsets with DST and fractional-hour support", () => {
    const winter = new Date("2026-01-15T12:00:00.000Z");
    const summer = new Date("2026-07-15T12:00:00.000Z");

    expect(timezoneOffsetMinutes("America/New_York", winter)).toBe(-300);
    expect(timezoneOffsetMinutes("America/New_York", summer)).toBe(-240);
    expect(formatTimezoneOffset("America/New_York", summer)).toBe("UTC−04:00");
    expect(formatTimezoneOffset("Asia/Kolkata", summer)).toBe("UTC+05:30");
    expect(formatTimezoneOffset("UTC", summer)).toBe("UTC+00:00");
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
