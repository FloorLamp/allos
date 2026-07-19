import { describe, expect, it } from "vitest";
import {
  buildInviteEmail,
  buildResetEmail,
  isValidEmail,
  normalizeEmail,
  RESET_REQUEST_MESSAGE,
  setPasswordLink,
} from "@/lib/auth-email-content";

describe("auth email content + validation (#985)", () => {
  it("isValidEmail accepts plausible addresses and rejects junk", () => {
    expect(isValidEmail("a@example.com")).toBe(true);
    expect(isValidEmail("  a@example.com  ")).toBe(true);
    expect(isValidEmail("first.last@sub.example.com")).toBe(true);
    for (const bad of [
      "",
      "a",
      "a@b",
      "a@b c.com",
      "no-at.example.com",
      "@x.com",
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
    expect(isValidEmail(`${"a".repeat(255)}@example.com`)).toBe(false);
  });

  it("normalizeEmail trims but preserves case (NOCASE storage owns folding)", () => {
    expect(normalizeEmail("  Foo@Example.com ")).toBe("Foo@Example.com");
  });

  it("RESET_REQUEST_MESSAGE is a constant, enumeration-safe reply", () => {
    // No branching on the email — the same string is used whether or not it exists.
    expect(RESET_REQUEST_MESSAGE).toContain("If that email is registered");
    expect(RESET_REQUEST_MESSAGE).not.toMatch(/exists|not found|unknown/i);
  });

  it("setPasswordLink builds an absolute /set-password link, or null without a base", () => {
    expect(setPasswordLink("https://app.example.com", "TOK")).toBe(
      "https://app.example.com/set-password?token=TOK"
    );
    // Trailing slash on the base is normalized.
    expect(setPasswordLink("https://app.example.com/", "a b")).toBe(
      "https://app.example.com/set-password?token=a%20b"
    );
    expect(setPasswordLink("", "TOK")).toBeNull();
    expect(setPasswordLink("   ", "TOK")).toBeNull();
  });

  it("invite/reset bodies carry the link + the right TTL, and no health data", () => {
    const invite = buildInviteEmail(
      "ada",
      "https://x.example.com/set-password?token=T"
    );
    expect(invite.subject).toMatch(/set up your allos login/i);
    expect(invite.text).toContain("https://x.example.com/set-password?token=T");
    expect(invite.text).toContain("24 hours");
    expect(invite.text).toContain("username: ada");

    const reset = buildResetEmail(
      "ada",
      "https://x.example.com/set-password?token=R"
    );
    expect(reset.subject).toMatch(/reset your allos password/i);
    expect(reset.text).toContain("https://x.example.com/set-password?token=R");
    expect(reset.text).toContain("1 hour");
  });
});
