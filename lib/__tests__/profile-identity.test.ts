import { describe, expect, it } from "vitest";
import {
  IDENTITY_AVATARS_SHOWN,
  identityBarLabel,
  identityBarView,
} from "@/lib/profile-identity";

const P = (id: number, name: string) => ({ id, name });

// The accessible set is ordered by id (ProfileScope's contract).
const ACCESSIBLE = [
  P(1, "Alice"),
  P(2, "Bob"),
  P(3, "Cara"),
  P(4, "Dev"),
  P(5, "Eve"),
];

describe("identityBarView", () => {
  it("names the single in-view profile with no ornament", () => {
    const view = identityBarView(ACCESSIBLE, [1], 1)!;
    expect(view.nameLine).toBe("Alice");
    expect(view.overflow).toBe(0);
    expect(view.ordered.map((p) => p.id)).toEqual([1]);
  });

  it("joins two in-view profiles", () => {
    const view = identityBarView(ACCESSIBLE, [1, 2], 1)!;
    expect(view.nameLine).toBe("Alice, Bob");
    expect(view.overflow).toBe(0);
  });

  it("collapses beyond two into +N more", () => {
    expect(identityBarView(ACCESSIBLE, [1, 2, 3], 1)!.nameLine).toBe(
      "Alice, Bob +1 more"
    );
    expect(identityBarView(ACCESSIBLE, [1, 2, 3, 4], 1)!.nameLine).toBe(
      "Alice, Bob +2 more"
    );
  });

  it("puts the ACTING profile first however the view-set is ordered", () => {
    // The safety rule made structural: writes land on `ordered[0]`'s subject, so
    // the ringed avatar and the emphasized name are positional, not decorative.
    const view = identityBarView(ACCESSIBLE, [1, 2, 3], 3)!;
    expect(view.acting.id).toBe(3);
    expect(view.ordered.map((p) => p.id)).toEqual([3, 1, 2]);
    expect(view.nameLine).toBe("Cara, Alice +1 more");
  });

  it("keeps the acting profile in view even if the view-set omits it", () => {
    const view = identityBarView(ACCESSIBLE, [2], 1)!;
    expect(view.ordered.map((p) => p.id)).toEqual([1, 2]);
  });

  it("never widens the view past the accessible set", () => {
    // A stale/tampered view-set naming an inaccessible profile cannot put that
    // profile on the bar — the accessible list is the only source of members.
    const view = identityBarView(ACCESSIBLE, [1, 99], 1)!;
    expect(view.ordered.map((p) => p.id)).toEqual([1]);
  });

  it("caps the avatar stack while the name line keeps counting", () => {
    const view = identityBarView(ACCESSIBLE, [1, 2, 3, 4, 5], 1)!;
    expect(view.avatars).toHaveLength(IDENTITY_AVATARS_SHOWN);
    expect(view.avatars[0].id).toBe(1);
    expect(view.ordered).toHaveLength(5);
    expect(view.nameLine).toBe("Alice, Bob +3 more");
  });

  it("returns null when the acting profile is not accessible", () => {
    expect(identityBarView(ACCESSIBLE, [1], 42)).toBeNull();
  });
});

describe("identityBarLabel", () => {
  it("states the acting fact", () => {
    expect(identityBarLabel("Alice")).toBe("Acting as Alice — switch profile");
  });
});
