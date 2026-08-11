import { describe, it, expect } from "vitest";
import {
  parsePrnLogCallback,
  parseRedoseLogCallback,
  redoseLogCallback,
  resolveTapProfile,
} from "@/lib/notifications/callback-data";

describe("parsePrnLogCallback (#797 /dose log button)", () => {
  it("parses a well-formed prn token", () => {
    expect(parsePrnLogCallback("prn:7:42:ab12cd34")).toEqual({
      profileId: 7,
      itemId: 42,
      token: "ab12cd34",
    });
  });
  it("rejects a wrong prefix, missing ids, or missing token", () => {
    expect(parsePrnLogCallback("take:7:42:0:2026-07-15")).toBeNull();
    expect(parsePrnLogCallback("prn:0:42:tok")).toBeNull();
    expect(parsePrnLogCallback("prn:7:0:tok")).toBeNull();
    expect(parsePrnLogCallback("prn:7:42:")).toBeNull();
    expect(parsePrnLogCallback("prn:7:42")).toBeNull();
    expect(parsePrnLogCallback(123)).toBeNull();
    expect(parsePrnLogCallback(null)).toBeNull();
  });
  it("cross-checks the token profile against the chat's profiles (shared with dose taps)", () => {
    const token = { profileId: 7 };
    expect(resolveTapProfile(token, [3, 7, 9])).toBe(7);
    expect(resolveTapProfile(token, [3, 9])).toBeNull();
  });
});

describe("parseRedoseLogCallback", () => {
  it("binds the notice to the administration that armed its window", () => {
    const encoded = redoseLogCallback(7, 42, 99, "ab12cd34");
    expect(parseRedoseLogCallback(encoded)).toEqual({
      profileId: 7,
      itemId: 42,
      administrationId: 99,
      token: "ab12cd34",
    });
  });

  it("rejects missing or invalid window identity", () => {
    expect(parseRedoseLogCallback("redose:7:42:0:tok")).toBeNull();
    expect(parseRedoseLogCallback("redose:7:42:99:")).toBeNull();
    expect(parseRedoseLogCallback("prn:7:42:tok")).toBeNull();
  });
});
