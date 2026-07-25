import { describe, expect, it } from "vitest";
import { appBadgeAction } from "@/lib/app-badge";

// The only decision the app-icon badge owns (issue #1424): set N, or clear. The
// COUNT is the hero's — see lib/__tests__/app-badge-chokepoint.test.ts, which
// guards that this module and its one caller never re-derive it.

describe("appBadgeAction", () => {
  it("sets the count when there is anything to attend to", () => {
    expect(appBadgeAction(1)).toEqual({ kind: "set", count: 1 });
    expect(appBadgeAction(7)).toEqual({ kind: "set", count: 7 });
  });

  it("clears at zero rather than setting 0", () => {
    // setAppBadge(0) shows a flag-style DOT on some platforms — a permanent mark
    // for a user who has resolved everything. Zero must clear.
    expect(appBadgeAction(0)).toEqual({ kind: "clear" });
  });

  it("clears on negative / non-finite input", () => {
    expect(appBadgeAction(-1)).toEqual({ kind: "clear" });
    expect(appBadgeAction(NaN)).toEqual({ kind: "clear" });
    expect(appBadgeAction(Infinity)).toEqual({ kind: "clear" });
  });

  it("floors a fractional count (a home-screen badge is an integer)", () => {
    expect(appBadgeAction(2.9)).toEqual({ kind: "set", count: 2 });
  });
});
