import { describe, it, expect } from "vitest";
import { avatarInitials } from "@/lib/avatar-initials";

describe("avatarInitials (#2615 item 1)", () => {
  it("takes the first letter of the first two words", () => {
    expect(avatarInitials("Jane Doe")).toBe("JD");
    expect(avatarInitials("Jane")).toBe("J");
    expect(avatarInitials("Ada Byron Lovelace")).toBe("AB");
  });

  it("skips a parenthetical qualifier instead of rendering its bracket", () => {
    // The defect: "Riley (child)" rendered "R(" — a parenthesis presented as an
    // initial. The seed ships exactly this name.
    expect(avatarInitials("Riley (child)")).toBe("RC");
    expect(avatarInitials("Riley (2)")).toBe("R2");
  });

  it("takes the word inside a bracket when there is one", () => {
    expect(avatarInitials("Riley (Chen)")).toBe("RC");
  });

  it("ignores a token with nothing alphanumeric in front", () => {
    expect(avatarInitials("Sam -- Jones")).toBe("SJ");
    expect(avatarInitials("Sam · Jones")).toBe("SJ");
  });

  it("is unicode-aware", () => {
    expect(avatarInitials("Ünal Sever")).toBe("ÜS");
    expect(avatarInitials("Мария Иванова")).toBe("МИ");
  });

  it("falls back to the first character when a name has no letters or digits", () => {
    expect(avatarInitials("🙂")).toBe("🙂");
    expect(avatarInitials("???")).toBe("?");
  });

  it("answers '?' for a blank name", () => {
    expect(avatarInitials("")).toBe("?");
    expect(avatarInitials("   ")).toBe("?");
  });
});
