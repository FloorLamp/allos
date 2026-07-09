import { describe, it, expect } from "vitest";
import {
  checkPasswordStrength,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "@/lib/password-strength";

describe("checkPasswordStrength", () => {
  it("accepts a reasonable password", () => {
    expect(checkPasswordStrength("Tr0ub4dour!x")).toEqual({ ok: true });
  });

  it("rejects a too-short password", () => {
    const r = checkPasswordStrength("Ab1cd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("uses the raised 10-char minimum (an old 8-char password fails)", () => {
    expect(checkPasswordStrength("Passw0rd").ok).toBe(false); // 8 chars
  });

  it("rejects a single-character-class password even if long", () => {
    expect(checkPasswordStrength("aaaaaaaaaaaa").ok).toBe(false);
    expect(checkPasswordStrength("123456789012").ok).toBe(false);
    expect(checkPasswordStrength("ABCDEFGHIJKL").ok).toBe(false);
  });

  it("accepts two classes at the minimum length", () => {
    expect(checkPasswordStrength("abcdefghi1").ok).toBe(true); // 10, lower+digit
  });

  it("rejects a password containing the username", () => {
    const r = checkPasswordStrength("myAdaLovelace9", {
      username: "adalovelace",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("username");
  });

  it("rejects a password that IS a substring of the username scenario reversed", () => {
    // password contained by username (short password) — still banned.
    const r = checkPasswordStrength("adalovel1AA", {
      username: "adalovel1aax",
    });
    expect(r.ok).toBe(false);
  });

  it("ignores a very short username for the containment rule", () => {
    // 2-char username must not ban passwords merely for containing "ab".
    expect(checkPasswordStrength("abcdefgh12", { username: "ab" }).ok).toBe(
      true
    );
  });

  it("rejects an over-long password", () => {
    const long = "aA1" + "x".repeat(MAX_PASSWORD_LENGTH);
    expect(checkPasswordStrength(long).ok).toBe(false);
  });
});
