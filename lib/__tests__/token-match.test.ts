import { describe, it, expect } from "vitest";
import {
  matchTokenToProfile,
  type TokenCandidate,
} from "../integrations/token-match";

describe("matchTokenToProfile", () => {
  const candidates: TokenCandidate[] = [
    { profileId: 1, token: "alpha-token" },
    { profileId: 2, token: "beta-token" },
  ];

  it("resolves a token to its owning profile", () => {
    expect(matchTokenToProfile("alpha-token", candidates)).toBe(1);
    expect(matchTokenToProfile("beta-token", candidates)).toBe(2);
  });

  it("returns null for an unknown token", () => {
    expect(matchTokenToProfile("gamma-token", candidates)).toBeNull();
  });

  it("returns null for empty/missing presented tokens", () => {
    expect(matchTokenToProfile(null, candidates)).toBeNull();
    expect(matchTokenToProfile(undefined, candidates)).toBeNull();
    expect(matchTokenToProfile("", candidates)).toBeNull();
  });

  it("ignores candidates with an empty token", () => {
    expect(matchTokenToProfile("", [{ profileId: 1, token: "" }])).toBeNull();
    expect(
      matchTokenToProfile("x", [
        { profileId: 1, token: "" },
        { profileId: 2, token: "x" },
      ])
    ).toBe(2);
  });

  it("does not match tokens of a different length (constant-time safe)", () => {
    expect(matchTokenToProfile("alpha", candidates)).toBeNull();
  });

  it("keeps the first matching candidate when a token is duplicated", () => {
    expect(
      matchTokenToProfile("dup", [
        { profileId: 1, token: "dup" },
        { profileId: 2, token: "dup" },
      ])
    ).toBe(1);
  });
});
