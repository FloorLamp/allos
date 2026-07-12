import { describe, it, expect } from "vitest";
import { disambiguateProfileNames } from "../profile-disambiguation";

describe("disambiguateProfileNames (issue #534)", () => {
  it("leaves unique names untouched", () => {
    const labels = disambiguateProfileNames([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ]);
    expect(labels.get(1)).toBe("Ada");
    expect(labels.get(2)).toBe("Grace");
  });

  it("appends a stable ordinal in id order to same-name profiles", () => {
    const labels = disambiguateProfileNames([
      { id: 5, name: "Alex" },
      { id: 2, name: "Alex" },
      { id: 9, name: "Sam" },
    ]);
    // Lower id gets (1), higher id gets (2) regardless of input order.
    expect(labels.get(2)).toBe("Alex (1)");
    expect(labels.get(5)).toBe("Alex (2)");
    expect(labels.get(9)).toBe("Sam");
  });

  it("treats case/whitespace-equal names as the same for collision detection", () => {
    const labels = disambiguateProfileNames([
      { id: 1, name: "Jo  Lee" },
      { id: 2, name: "jo lee" },
    ]);
    // Ordinal preserves each row's own original spelling.
    expect(labels.get(1)).toBe("Jo  Lee (1)");
    expect(labels.get(2)).toBe("jo lee (2)");
  });
});
