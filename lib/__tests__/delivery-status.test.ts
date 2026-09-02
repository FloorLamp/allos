import { describe, expect, it } from "vitest";
import {
  CHANNEL_ROW_LABEL,
  channelRowLine,
  channelRowState,
  foldFailures,
  type DeliveryOutcomeRow,
} from "../notifications/delivery-status";

// #2565 A. Every expectation is a pinned literal, never re-derived from the module.

const failing: DeliveryOutcomeRow = {
  state: "failing",
  detail: "Telegram API 401: Unauthorized",
  at: "2026-09-01T10:00:00Z",
};
const delivering: DeliveryOutcomeRow = {
  state: "delivering",
  detail: null,
  at: "2026-09-01T11:00:00Z",
};

describe("channelRowState — the four truthful states (owner ruling 2026-08-18)", () => {
  it.each([
    // Not set up dominates and HIDES a stale outcome, whichever it was.
    { setUp: false, row: null, expected: { state: "not-set-up" } },
    { setUp: false, row: delivering, expected: { state: "not-set-up" } },
    { setUp: false, row: failing, expected: { state: "not-set-up" } },
    // Configured with no completed attempt is Ready — never Delivering.
    { setUp: true, row: null, expected: { state: "ready" } },
    {
      setUp: true,
      row: delivering,
      expected: { state: "delivering", at: "2026-09-01T11:00:00Z" },
    },
    {
      setUp: true,
      row: failing,
      expected: {
        state: "erroring",
        detail: "Telegram API 401: Unauthorized",
        at: "2026-09-01T10:00:00Z",
      },
    },
    // A failure that recorded no sentence still names itself a failure.
    {
      setUp: true,
      row: { ...failing, detail: null },
      expected: {
        state: "erroring",
        detail: "unknown send failure",
        at: "2026-09-01T10:00:00Z",
      },
    },
  ])("setUp=$setUp row=$row.state → $expected.state", ({ setUp, row, expected }) => {
    expect(channelRowState(setUp, row)).toEqual(expected);
  });

  it("prints the ruling's four words, one per state", () => {
    expect(CHANNEL_ROW_LABEL).toEqual({
      "not-set-up": "Not set up",
      ready: "Ready",
      delivering: "Delivering",
      erroring: "Erroring",
    });
  });
});

describe("channelRowLine — what the strip row prints under the channel name", () => {
  // A stub age, so the sentence is asserted and not the relative-time thresholds
  // (those are lib/__tests__/format-date's). Its argument is echoed, which is how the
  // WHICH-instant half of each line is pinned.
  const age = (at: string) => `AGE(${at})`;
  const opts = { profileName: "Rosa", age };

  it.each([
    // Not set up names the tier that owes the step — the mixed-scope trap #2565 B
    // named for the matrix headers, answered here from the same `columnLiveness`.
    {
      state: { state: "not-set-up" } as const,
      blocker: "server" as const,
      expected: "Not set up — an admin configures it on Settings → Server.",
    },
    {
      state: { state: "not-set-up" } as const,
      blocker: "login" as const,
      expected: "Not set up — open this row to set it up.",
    },
    {
      state: { state: "not-set-up" } as const,
      blocker: "profile" as const,
      expected: "Not set up — open this row to set it up for Rosa.",
    },
    {
      state: { state: "ready" } as const,
      blocker: null,
      expected: "Ready — not tested yet.",
    },
    {
      state: { state: "delivering", at: "2026-09-01T11:00:00Z" } as const,
      blocker: null,
      expected: "Delivering — last message AGE(2026-09-01T11:00:00Z).",
    },
    {
      state: {
        state: "erroring",
        detail: "Telegram API 401: Unauthorized",
        at: "2026-09-01T10:00:00Z",
      } as const,
      blocker: null,
      expected:
        "Erroring — Telegram API 401: Unauthorized (AGE(2026-09-01T10:00:00Z)).",
    },
  ])("$state.state/$blocker", ({ state, blocker, expected }) => {
    expect(channelRowLine(state, { ...opts, blocker })).toBe(expected);
  });

  // The dot carries colour and nothing else, so the WORD has to be in the text.
  it("opens every line with that state's own word", () => {
    const lines = [
      channelRowLine({ state: "not-set-up" }, { ...opts, blocker: "login" }),
      channelRowLine({ state: "ready" }, { ...opts, blocker: null }),
      channelRowLine(
        { state: "delivering", at: "2026-09-01T11:00:00Z" },
        { ...opts, blocker: null }
      ),
      channelRowLine(
        { state: "erroring", detail: "boom", at: "2026-09-01T10:00:00Z" },
        { ...opts, blocker: null }
      ),
    ];
    expect(lines.map((l) => l.split(" — ")[0])).toEqual(
      Object.values(CHANNEL_ROW_LABEL)
    );
  });
});

describe("foldFailures — the Settings → Server aggregate", () => {
  const tg = { channel: "telegram", detail: "401", at: "2026-09-01T10:00:00Z" };
  const ha = { channel: "home-assistant", detail: "HTTP 500", at: "2026-09-01T10:00:00Z" };
  const later = { channel: "email", detail: "relay refused", at: "2026-09-02T08:00:00Z" };

  it.each([
    { name: "nothing failing", rows: [], expected: null },
    {
      name: "one failure",
      rows: [tg],
      expected: { error: "401", at: "2026-09-01T10:00:00Z", channel: "telegram" },
    },
    {
      name: "the most recent attempt wins",
      rows: [tg, later, ha],
      expected: { error: "relay refused", at: "2026-09-02T08:00:00Z", channel: "email" },
    },
    {
      name: "a same-second tie breaks by channel order, whichever came first in the list",
      rows: [ha, tg],
      expected: { error: "401", at: "2026-09-01T10:00:00Z", channel: "telegram" },
    },
    {
      name: "a failure with no sentence is one this surface cannot explain",
      rows: [{ channel: "push", detail: null, at: "2026-09-03T00:00:00Z" }, tg],
      expected: { error: "401", at: "2026-09-01T10:00:00Z", channel: "telegram" },
    },
  ])("$name", ({ rows, expected }) => {
    expect(foldFailures(rows)).toEqual(expected);
  });
});
