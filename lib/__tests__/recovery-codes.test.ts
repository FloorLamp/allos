import { describe, it, expect } from "vitest";
import {
  normalizeRecoveryCode,
  formatRecoveryCode,
  isRecoveryCodeShape,
  hashRecoveryCode,
  generateRecoveryCodes,
  RECOVERY_CODE_COUNT,
} from "@/lib/recovery-codes";

describe("recovery-code normalization + format", () => {
  it("normalizes case, spaces, and dashes to a canonical form", () => {
    expect(normalizeRecoveryCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeRecoveryCode("ABCD EFGH")).toBe("ABCDEFGH");
    expect(normalizeRecoveryCode("a b c d e f g h")).toBe("ABCDEFGH");
  });

  it("formats a normalized code as XXXX-XXXX", () => {
    expect(formatRecoveryCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(formatRecoveryCode("abcdefgh")).toBe("ABCD-EFGH");
  });

  it("hashes independent of display formatting", () => {
    expect(hashRecoveryCode("ABCD-EFGH")).toBe(hashRecoveryCode("abcdefgh"));
    expect(hashRecoveryCode("ABCD-EFGH")).not.toBe(
      hashRecoveryCode("ABCD-EFGJ")
    );
  });

  it("hash is a 64-char hex sha256", () => {
    expect(hashRecoveryCode("ABCD-EFGH")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("recovery-code shape", () => {
  it("accepts a well-formed code", () => {
    expect(isRecoveryCodeShape("ABCD-EFGH")).toBe(true);
    expect(isRecoveryCodeShape("abcdefgh")).toBe(true);
  });

  it("rejects a 6-digit TOTP (distinguishes the two at login)", () => {
    expect(isRecoveryCodeShape("123456")).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isRecoveryCodeShape("ABCD-EFG")).toBe(false);
    expect(isRecoveryCodeShape("ABCD-EFGHI")).toBe(false);
  });
});

describe("generateRecoveryCodes", () => {
  it("returns the expected count of distinct, well-shaped codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(isRecoveryCodeShape(c)).toBe(true);
    }
  });
});
