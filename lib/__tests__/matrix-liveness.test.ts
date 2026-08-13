import { describe, expect, it } from "vitest";
import {
  cellInkNote,
  columnLiveness,
  columnStateLabel,
  deadColumnNotes,
  isColumnReady,
  matrixCellInk,
  type ChannelReadiness,
  type DeadColumn,
} from "@/lib/notifications/matrix-liveness";

// #2565 part B. Every expectation here is a PINNED LITERAL, never a re-derivation from
// the module under test: a test that computes its answer the way the code does passes
// with the feature gutted.

const ready: ChannelReadiness = {
  serverReady: true,
  targetReady: true,
  targetScope: "login",
};

describe("columnLiveness", () => {
  it("is ready only when both halves hold", () => {
    expect(columnLiveness(ready)).toEqual({ state: "ready" });
  });

  it("blames the SERVER when the instance technology is missing, even if the target is ready", () => {
    // The ordering rule: an admin's missing bot token blocks a member's chat id, so
    // sending the member to their own card would be sending them nowhere.
    expect(
      columnLiveness({ ...ready, serverReady: false, targetReady: true })
    ).toEqual({ state: "not-set-up", blocker: "server" });
  });

  it("blames the LOGIN tier when the login owns the missing target", () => {
    expect(
      columnLiveness({
        serverReady: true,
        targetReady: false,
        targetScope: "login",
      })
    ).toEqual({ state: "not-set-up", blocker: "login" });
  });

  it("blames the PROFILE tier when the profile owns the missing target", () => {
    expect(
      columnLiveness({
        serverReady: true,
        targetReady: false,
        targetScope: "profile",
      })
    ).toEqual({ state: "not-set-up", blocker: "profile" });
  });

  it("still blames the server when BOTH halves are missing", () => {
    expect(
      columnLiveness({
        serverReady: false,
        targetReady: false,
        targetScope: "profile",
      })
    ).toEqual({ state: "not-set-up", blocker: "server" });
  });

  it("preserves the pre-#2565 single boolean exactly: ready === serverReady AND targetReady", () => {
    const cases: [boolean, boolean, boolean][] = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ];
    for (const [serverReady, targetReady, expected] of cases) {
      expect(
        isColumnReady(
          columnLiveness({ serverReady, targetReady, targetScope: "login" })
        )
      ).toBe(expected);
    }
  });
});

describe("columnStateLabel", () => {
  // The words are pinned, and deliberately NOT "delivering": whether messages are
  // landing is a notify_lifecycle question this module does not ask.
  it("states configuration, not delivery health", () => {
    expect(columnStateLabel({ state: "ready" })).toBe("set up");
    expect(columnStateLabel({ state: "not-set-up", blocker: "server" })).toBe(
      "not set up"
    );
    expect(columnStateLabel({ state: "ready" })).not.toContain("deliver");
  });
});

describe("matrixCellInk", () => {
  it("gives the three states of the grid", () => {
    expect(matrixCellInk(true, true)).toBe("live");
    expect(matrixCellInk(false, true)).toBe("ghost");
    expect(matrixCellInk(true, false)).toBe("off");
    expect(matrixCellInk(false, false)).toBe("off");
  });

  // The inequality this whole change exists to hold. A kept preference waiting on one
  // setup step is NOT a preference the user turned off, and collapsing the two is the
  // deceptive-success failure mode: the grid looks calmer and a stored consent reads
  // as a refusal.
  it("never collapses a kept preference into an off one", () => {
    expect(matrixCellInk(false, true)).not.toBe(matrixCellInk(false, false));
    expect(matrixCellInk(false, true)).not.toBe(matrixCellInk(true, true));
    expect(
      new Set([
        matrixCellInk(true, true),
        matrixCellInk(false, true),
        matrixCellInk(true, false),
      ]).size
    ).toBe(3);
  });

  it("announces the ghost in words, because opacity is not in the accessibility tree", () => {
    expect(cellInkNote("ghost")).toBe("kept, waiting on this channel's setup");
    expect(cellInkNote("live")).toBeNull();
    expect(cellInkNote("off")).toBeNull();
  });
});

describe("deadColumnNotes", () => {
  const opts = { isAdmin: false, profileName: "Robin" };
  const dead = (label: string, blocker: "server" | "login" | "profile") =>
    ({ label, liveness: { state: "not-set-up", blocker } }) as DeadColumn;
  const live = (label: string) =>
    ({ label, liveness: { state: "ready" } }) as DeadColumn;

  it("says nothing when every column is set up", () => {
    expect(deadColumnNotes([live("Telegram"), live("Email")], opts)).toEqual(
      []
    );
  });

  it("gives a member the server sentence without sending them to an admin-only page's control", () => {
    expect(deadColumnNotes([dead("Telegram", "server")], opts)).toEqual([
      "Telegram isn’t set up on this server yet — an admin configures it on Settings → Server.",
    ]);
  });

  it("gives an admin the same fact as an instruction", () => {
    expect(
      deadColumnNotes([dead("Telegram", "server")], { ...opts, isAdmin: true })
    ).toEqual([
      "Telegram isn’t set up on this server yet — configure it on Settings → Server.",
    ]);
  });

  it("names the LOGIN tier as 'your login' and the PROFILE tier by the profile's name", () => {
    expect(deadColumnNotes([dead("Web Push", "login")], opts)).toEqual([
      "Web Push isn’t set up for your login yet — its card is in Channels above.",
    ]);
    expect(deadColumnNotes([dead("Home Assistant", "profile")], opts)).toEqual([
      "Home Assistant isn’t set up for Robin yet — its card is in Channels above.",
    ]);
  });

  // The mixed-scope guarantee, as a test rather than a caption: one sentence per
  // OWNER, in server → login → profile order, so three tiers can never be flattened
  // into one undifferentiated "not set up".
  it("emits one sentence per blocking owner, in tier order, grouping same-owner columns", () => {
    expect(
      deadColumnNotes(
        [
          dead("Telegram", "server"),
          dead("Web Push", "login"),
          dead("Home Assistant", "profile"),
          dead("Email", "server"),
          live("Something live"),
        ],
        opts
      )
    ).toEqual([
      "Telegram and Email aren’t set up on this server yet — an admin configures them on Settings → Server.",
      "Web Push isn’t set up for your login yet — its card is in Channels above.",
      "Home Assistant isn’t set up for Robin yet — its card is in Channels above.",
    ]);
  });

  it("joins three same-owner columns with commas and a final 'and'", () => {
    expect(
      deadColumnNotes(
        [
          dead("Telegram", "server"),
          dead("Web Push", "server"),
          dead("Email", "server"),
        ],
        opts
      )
    ).toEqual([
      "Telegram, Web Push and Email aren’t set up on this server yet — an admin configures them on Settings → Server.",
    ]);
  });
});
