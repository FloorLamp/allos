// PURE TIER (#1779) — the reconcile decision and the keyboard surgery it does.
//
// The invariant every case here defends: reconciliation only ever REDUCES what a chat
// claims, it makes NO call when nothing changed, and it never closes a message on the
// strength of a button nobody has reasoned about.

import { describe, it, expect } from "vitest";
import {
  decideProseGather,
  decideReconcile,
  formatProseGatherRecord,
  keyboardTokens,
  parseProseGatherRecord,
  reconcileClosingText,
  closingTallyText,
  RECONCILE_CLOSING,
  stripTokens,
  tokenPrefix,
} from "@/lib/notifications/reconcile-core";
import {
  messageExpiry,
  owningFamily,
} from "@/lib/notifications/reconcile-registry";
import { shiftDateStr } from "@/lib/date";
import { DOSE_LOG_DATE_WINDOW_DAYS } from "@/lib/dose-log-window";
import type { InlineKeyboard } from "@/lib/notifications/telegram-render";

const DATE = "2020-03-04";

function kb(...rows: string[][]): InlineKeyboard {
  return rows.map((row) =>
    row.map((token) => ({ text: token, callback_data: token }))
  );
}

const TAKE_A = `take:7:11:3:${DATE}`;
const TAKE_B = `take:7:12:3:${DATE}`;
const SKIP_A = `skip:7:11:3:${DATE}`;
const TUNE = `tune:7:${DATE}`;

describe("tokenPrefix", () => {
  it("reads the prefix of a callback token", () => {
    expect(tokenPrefix(TAKE_A)).toBe("take");
    expect(tokenPrefix("hh:1:2:3:4:2020-03-04")).toBe("hh");
  });

  it("has no prefix for a url button, an empty token or a colonless one", () => {
    expect(tokenPrefix(undefined)).toBeNull();
    expect(tokenPrefix("")).toBeNull();
    expect(tokenPrefix(":leading")).toBeNull();
    expect(tokenPrefix("nocolon")).toBeNull();
  });
});

describe("keyboardTokens", () => {
  it("reads every callback token in keyboard order", () => {
    expect(keyboardTokens(kb([TAKE_A, SKIP_A], [TAKE_B]))).toEqual([
      TAKE_A,
      SKIP_A,
      TAKE_B,
    ]);
  });

  it("ignores deep-link buttons — a url carries no claim", () => {
    const keyboard: InlineKeyboard = [
      [
        { text: "Open", url: "https://example.invalid/x" },
        { text: "t", callback_data: TAKE_A },
      ],
    ];
    expect(keyboardTokens(keyboard)).toEqual([TAKE_A]);
  });
});

describe("stripTokens", () => {
  it("removes named buttons and collapses rows left empty", () => {
    const out = stripTokens(
      kb([TAKE_A, SKIP_A], [TAKE_B]),
      new Set([TAKE_A, SKIP_A])
    );
    expect(out).toHaveLength(1);
    expect(keyboardTokens(out)).toEqual([TAKE_B]);
  });

  it("never removes a deep-link button", () => {
    const keyboard: InlineKeyboard = [
      [{ text: "Open", url: "https://example.invalid/x" }],
      [{ text: "t", callback_data: TAKE_A }],
    ];
    const out = stripTokens(keyboard, new Set([TAKE_A]));
    expect(out).toEqual([[{ text: "Open", url: "https://example.invalid/x" }]]);
  });
});

describe("decideReconcile — the steady state", () => {
  it("makes NO call when nothing resolved (the rate-limit pin)", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A, TAKE_B]),
        dead: new Set(),
        inert: new Set(),
        expired: null,
      })
    ).toEqual({ action: "none" });
  });

  it("makes NO call for a keyboard of purely inert controls", () => {
    expect(
      decideReconcile({
        keyboard: kb([TUNE]),
        dead: new Set(),
        inert: new Set([TUNE]),
        expired: null,
      })
    ).toEqual({ action: "none" });
  });

  it("leaves an UNRECOGNIZED keyboard alone — failing safe, never closing blind", () => {
    // No family claimed these tokens, so `dead` is empty: the message survives intact
    // rather than being closed on a guess.
    expect(
      decideReconcile({
        keyboard: kb(["mystery:1:2"]),
        dead: new Set(),
        inert: new Set(),
        expired: null,
      })
    ).toEqual({ action: "none" });
  });
});

describe("decideReconcile — partial and full resolution", () => {
  it("strips only the resolved buttons when others remain", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A, SKIP_A], [TAKE_B]),
      dead: new Set([TAKE_A, SKIP_A]),
      inert: new Set(),
      expired: null,
    });
    expect(d.action).toBe("strip");
    if (d.action !== "strip") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toEqual([TAKE_B]);
  });

  it("closes when every CLAIM is resolved", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A], [TAKE_B]),
        dead: new Set([TAKE_A, TAKE_B]),
        inert: new Set(),
        expired: null,
      })
    ).toEqual({ action: "close", reason: "resolved" });
  });

  it("an INERT control does not keep a fully resolved message alive", () => {
    // The digest's ⚙️ Tune and the offer tail ride other messages; they must not make a
    // resolved dose reminder look outstanding forever.
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A], [TUNE]),
        dead: new Set([TAKE_A]),
        inert: new Set([TUNE]),
        expired: null,
      })
    ).toEqual({ action: "close", reason: "resolved" });
  });

  it("an inert control is never itself reported dead", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A, TUNE], [TAKE_B]),
      dead: new Set([TAKE_A, TUNE]),
      inert: new Set([TUNE]),
      expired: null,
    });
    expect(d.action).toBe("strip");
    if (d.action !== "strip") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toContain(TUNE);
  });
});

describe("decideReconcile — an EXPIRED message", () => {
  it("closes it outright when every button is a claim", () => {
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A, TAKE_B]),
        dead: new Set(),
        inert: new Set(),
        expired: "rollover",
      })
    ).toEqual({ action: "close", reason: "rollover" });
  });

  it("expiry wins over per-token state — an unresolved claim still goes", () => {
    // Its tokens WOULD be refused now (that is what the verdict means), so leaving them
    // tappable is worse than removing them. This is also the residual #947 gap: the last
    // nudge of an evening used to stay live until the NEXT send.
    const d = decideReconcile({
      keyboard: kb([TAKE_A]),
      dead: new Set(),
      inert: new Set(),
      expired: "rollover",
    });
    expect(d).toEqual({ action: "close", reason: "rollover" });
  });

  it("closes with the reason it was GIVEN — a run-out window is not 'yesterday'", () => {
    // The two date closes are different sentences to the reader (#2018), so the pure
    // decision must carry the verdict through rather than flattening it to one word.
    expect(
      decideReconcile({
        keyboard: kb([TAKE_A]),
        dead: new Set(),
        inert: new Set(),
        expired: "expired",
      })
    ).toEqual({ action: "close", reason: "expired" });
  });

  it("keeps inert controls when expiring a mixed keyboard", () => {
    const d = decideReconcile({
      keyboard: kb([TAKE_A], [TUNE]),
      dead: new Set(),
      inert: new Set([TUNE]),
      expired: "rollover",
    });
    expect(d.action).toBe("strip-all");
    if (d.action !== "strip-all") throw new Error("unreachable");
    expect(keyboardTokens(d.keyboard)).toEqual([TUNE]);
  });

  it("an expired keyboard with nothing but inert controls needs no call", () => {
    expect(
      decideReconcile({
        keyboard: kb([TUNE]),
        dead: new Set(),
        inert: new Set([TUNE]),
        expired: "rollover",
      })
    ).toEqual({ action: "none" });
  });
});

describe("the closing lines", () => {
  it("say WHY the buttons are gone, without celebrating or judging", () => {
    expect(RECONCILE_CLOSING.resolved).toContain("app");
    expect(RECONCILE_CLOSING.rollover).toContain("yesterday");
  });

  it("a run-out dose window names the CONSEQUENCE, not the calendar (#2018)", () => {
    // "This is yesterday's message." is both wrong (it is older than that) and
    // unhelpful for a dose closed at the end of its ±2-day window: what the reader
    // needs to know is that the confirm can no longer land here and where it can.
    expect(RECONCILE_CLOSING.expired).not.toContain("yesterday");
    expect(RECONCILE_CLOSING.expired).toContain("app");
    expect(RECONCILE_CLOSING.expired).not.toBe(RECONCILE_CLOSING.rollover);
    expect(RECONCILE_CLOSING.expired.toLowerCase()).not.toMatch(
      /great|well done|nice|missed|you /
    );
  });
});

// ---- The close names its subject (issue #1822 item 7) ----
//
// A close replaces the ENTIRE message text, so the bare lines above arrived as orphan
// bubbles: at 08:00 the reader saw "Handled in the app — nothing left here." with no
// indication of WHAT was handled, and in a shared family chat the "[Name] " attribution
// went with the rest of the text. The tap path solved this long ago
// (replacementWithTitle, #377); the reconcile close now follows the same convention.

describe("reconcileClosingText (#1822 item 7)", () => {
  const TITLE = "[Norton] 🍽️ Morning food log";

  it("names the subject on a RESOLVED close, attribution intact", () => {
    expect(reconcileClosingText("resolved", TITLE)).toBe(
      "[Norton] 🍽️ Morning food log — handled in the app."
    );
  });

  it("names the subject on a ROLLOVER close too", () => {
    expect(reconcileClosingText("rollover", TITLE)).toBe(
      "[Norton] 🍽️ Morning food log — this was yesterday's message."
    );
  });

  it("names the subject on an EXPIRED close too", () => {
    expect(reconcileClosingText("expired", TITLE)).toBe(
      "[Norton] 🍽️ Morning food log — too late to confirm here, log it in the app."
    );
  });

  it("keeps the closes distinguishable — a rollover is not 'handled'", () => {
    const texts = (["resolved", "rollover", "expired"] as const).map((r) =>
      reconcileClosingText(r, TITLE)
    );
    expect(new Set(texts).size).toBe(texts.length);
    // None celebrates or judges (#992/#716) — this corrects the app's own display.
    for (const text of texts) {
      expect(text.toLowerCase()).not.toMatch(
        /great|well done|nice|missed|you /
      );
    }
  });

  it("takes the TITLE LINE only, trimmed — the replacementWithTitle convention", () => {
    expect(
      reconcileClosingText("resolved", "  [Ada] 💊 Morning doses  \nTake 2…")
    ).toBe("[Ada] 💊 Morning doses — handled in the app.");
  });

  it("two subjects in one chat stay distinguishable", () => {
    expect(reconcileClosingText("resolved", "[Ada] 💊 Morning doses")).not.toBe(
      reconcileClosingText("resolved", "[Ben] 💊 Morning doses")
    );
  });

  it("degrades to the bare line rather than inventing a subject", () => {
    // A pointer recorded before migration 139 has no title; so does a title-less message.
    for (const missing of [null, undefined, "", "   ", "\n…"]) {
      expect(reconcileClosingText("resolved", missing)).toBe(
        RECONCILE_CLOSING.resolved
      );
      expect(reconcileClosingText("rollover", missing)).toBe(
        RECONCILE_CLOSING.rollover
      );
    }
  });
});

// ---- THE OUTCOME TALLY (issue #2170) ----
//
// A resolved close replaced the ENTIRE message text, so the chat ended up knowing LESS
// than the reminder had said: something was recorded, but not what. The counts below are
// the reconcile's own resolution facts restated — no new read, no second computation.

describe("reconcileClosingText outcome tally (#2170)", () => {
  const DOSES = "[Norton] 💊 Evening supplements";

  it("states the tally on a resolved close", () => {
    expect(
      reconcileClosingText("resolved", DOSES, { logged: 5, skipped: 1 })
    ).toBe(
      "[Norton] 💊 Evening supplements — 5 logged, 1 skipped. In the app."
    );
  });

  it("says only what happened — all logged, or all skipped", () => {
    expect(
      reconcileClosingText("resolved", DOSES, { logged: 6, skipped: 0 })
    ).toBe("[Norton] 💊 Evening supplements — 6 logged. In the app.");
    expect(
      reconcileClosingText("resolved", DOSES, { logged: 0, skipped: 2 })
    ).toBe("[Norton] 💊 Evening supplements — 2 skipped. In the app.");
  });

  it("falls back to today's sentence with nothing to count", () => {
    for (const tally of [null, undefined, { logged: 0, skipped: 0 }]) {
      expect(reconcileClosingText("resolved", DOSES, tally)).toBe(
        "[Norton] 💊 Evening supplements — handled in the app."
      );
    }
  });

  it("the other close reasons are byte-identical to today", () => {
    // They close for time/lifecycle reasons, where a tally would be wrong or unknowable.
    const tally = { logged: 5, skipped: 1 };
    for (const reason of ["rollover", "expired", "superseded"] as const) {
      expect(reconcileClosingText(reason, DOSES, tally)).toBe(
        reconcileClosingText(reason, DOSES)
      );
    }
  });

  it("a subjectless pointer has no per-item facts either", () => {
    expect(
      reconcileClosingText("resolved", null, { logged: 5, skipped: 1 })
    ).toBe(RECONCILE_CLOSING.resolved);
  });

  it("counts only — never an item list, never a judgment", () => {
    const text = reconcileClosingText("resolved", DOSES, {
      logged: 5,
      skipped: 1,
    });
    // The pin the design promises: a tally reassures that it is recorded; a list turns
    // a correction of the app's own display into a report.
    expect(text.split("—")[1]).toMatch(/^[\s\d,a-z.]+ In the app\.$/);
    expect(text.toLowerCase()).not.toMatch(/great|well done|nice|you /);
  });

  it("the attributed subject survives exactly as it does today (#1822 item 7)", () => {
    expect(
      reconcileClosingText("resolved", "  [Ada] 💊 Morning doses  \nTake 2…", {
        logged: 2,
        skipped: 0,
      })
    ).toBe("[Ada] 💊 Morning doses — 2 logged. In the app.");
  });
});

describe("closingTallyText (#2170)", () => {
  it("renders each present count, in ledger order", () => {
    expect(closingTallyText({ logged: 5, skipped: 1 })).toBe(
      "5 logged, 1 skipped"
    );
    expect(closingTallyText({ logged: 1, skipped: 0 })).toBe("1 logged");
    expect(closingTallyText({ logged: 0, skipped: 3 })).toBe("3 skipped");
    expect(closingTallyText({ logged: 0, skipped: 0 })).toBeNull();
  });
});

// ---- WHOSE ANSWER "too late" IS (issue #2018) ----
//
// The sweep composes two things: `messageExpiry` (the FAMILY's own date guard, the one
// its tap handler consults) and `decideReconcile` (the mechanics). #1784 shipped only the
// mechanics, with the day boundary hard-coded into them, so a bedtime dose reminder lost
// its buttons at the first tick after local midnight while `markDoseTaken` was still
// built to honor the tap for two more days (#614).
//
// These cases run the same composition the sweep runs, on the SAME fixture shape for two
// families, and get opposite verdicts. That pairing is the whole ruling.

const D = "2020-03-04";

// What the sweep would do with a message dated D, seen on `todayDate` — family resolved
// from the keyboard exactly as the sweep resolves it.
function sweepVerdict(keyboard: InlineKeyboard, todayDate: string) {
  const tokens = keyboardTokens(keyboard);
  return decideReconcile({
    keyboard,
    dead: new Set(),
    inert: new Set(),
    expired: messageExpiry(owningFamily(tokens, tokenPrefix), D, todayDate),
  });
}

describe("a dose keyboard lives exactly as long as the write core honors the tap", () => {
  // A bedtime reminder: sent at 22:00 on D, still unconfirmed.
  const DOSE = kb([`take:7:11:3:${D}`, `skip:7:11:3:${D}`]);

  it("survives the first tick after local midnight — the reported regression", () => {
    expect(sweepVerdict(DOSE, shiftDateStr(D, 1))).toEqual({ action: "none" });
  });

  it("survives every day inside DOSE_LOG_DATE_WINDOW_DAYS", () => {
    for (let d = 0; d <= DOSE_LOG_DATE_WINDOW_DAYS; d++) {
      expect(
        sweepVerdict(DOSE, shiftDateStr(D, d)),
        `a dose message should still be tappable on D+${d}`
      ).toEqual({ action: "none" });
    }
  });

  it("closes the day AFTER the window runs out, naming the consequence", () => {
    expect(
      sweepVerdict(DOSE, shiftDateStr(D, DOSE_LOG_DATE_WINDOW_DAYS + 1))
    ).toEqual({ action: "close", reason: "expired" });
  });

  it("the ESCALATION tier gets the same window — it runs the same write cores", () => {
    const esc = kb([`esctake:7:11:3:${D}`, `escack:7:11:3:${D}`]);
    expect(sweepVerdict(esc, shiftDateStr(D, 1))).toEqual({ action: "none" });
    expect(
      sweepVerdict(esc, shiftDateStr(D, DOSE_LOG_DATE_WINDOW_DAYS + 1))
    ).toEqual({ action: "close", reason: "expired" });
  });
});

describe("a food keyboard still dies at the day boundary", () => {
  // Same fixture shape, opposite verdict: the food token's date is the system's GUESS at
  // when the user ate, and the guess expires at midnight (#947).
  const FOOD = kb([`food:7:Morning:${D}:leafy_greens`]);

  it("is closed on D+1", () => {
    expect(sweepVerdict(FOOD, shiftDateStr(D, 1))).toEqual({
      action: "close",
      reason: "rollover",
    });
  });

  it("is untouched on D itself", () => {
    expect(sweepVerdict(FOOD, D)).toEqual({ action: "none" });
  });

  it("the household round follows food, not the dose — its handler is exact-day", () => {
    const hh = kb([`hh:7:8:11:3:${D}`]);
    expect(sweepVerdict(hh, shiftDateStr(D, 1))).toEqual({
      action: "close",
      reason: "rollover",
    });
  });
});

describe("a family with no date axis is governed by `dead` alone", () => {
  const DRAFT = kb([`wofinish:7:99`, `wodiscard:7:99`]);

  it("a live draft's keyboard survives midnight — date is not an axis it has", () => {
    for (let d = 0; d <= 3; d++) {
      expect(sweepVerdict(DRAFT, shiftDateStr(D, d))).toEqual({
        action: "none",
      });
    }
  });

  it("and is closed whenever the draft stops being the live session, whatever the date", () => {
    // `dead` from getWorkoutPresence — the ONLY thing that ends this message.
    for (const day of [D, shiftDateStr(D, 5)]) {
      expect(
        decideReconcile({
          keyboard: DRAFT,
          dead: new Set(keyboardTokens(DRAFT)),
          inert: new Set(),
          expired: messageExpiry(
            owningFamily(keyboardTokens(DRAFT), tokenPrefix),
            D,
            day
          ),
        })
      ).toEqual({ action: "close", reason: "resolved" });
    }
  });
});

// ---- Is the rebuild worth paying for? (#2069) ------------------------------
//
// The prose arm's guard. What it must NEVER do is let a stale claim stand: every case
// below that is not the exact "same day, same stamp, inside the floor" one has to come
// out as `gather`, because the render is the only thing that can find the change.

describe("the prose rebuild's cheap pre-check (#2069)", () => {
  const FLOOR = 3 * 60 * 60 * 1000;
  const T0 = Date.parse("2026-08-05T09:00:00Z");
  const record = (over: Partial<{ date: string; stamp: string; at: number }>) =>
    ({ date: D, stamp: "s1", at: T0, ...over }) as const;

  const gate = (over: {
    stamp?: string | null;
    last?: ReturnType<typeof record> | null;
    date?: string;
    nowMs?: number;
  }) =>
    decideProseGather({
      date: over.date ?? D,
      stamp: over.stamp === undefined ? "s1" : over.stamp,
      last: over.last === undefined ? record({}) : over.last,
      nowMs: over.nowMs ?? T0 + 60 * 60 * 1000,
      floorMs: FLOOR,
    });

  it("skips the rebuild only when the day, the stamp AND the floor all agree", () => {
    expect(gate({})).toEqual({ gather: false, reason: "unchanged" });
  });

  it("rebuilds on the first pass, when there is nothing recorded to compare", () => {
    expect(gate({ last: null })).toEqual({ gather: true, reason: "no-record" });
  });

  it("rebuilds when the stamp moved — the user resolved something", () => {
    expect(gate({ stamp: "s2" })).toEqual({
      gather: true,
      reason: "stamp-moved",
    });
  });

  it("rebuilds for a pointer on a different day than the record", () => {
    expect(gate({ date: shiftDateStr(D, 1) })).toEqual({
      gather: true,
      reason: "new-day",
    });
  });

  it("rebuilds past the floor even when the stamp says nothing moved — the stamp is an accelerator, never an oracle", () => {
    expect(gate({ nowMs: T0 + FLOOR })).toEqual({
      gather: true,
      reason: "floor",
    });
    expect(gate({ nowMs: T0 + FLOOR - 1 })).toEqual({
      gather: false,
      reason: "unchanged",
    });
  });

  it("treats a record from the FUTURE as no evidence at all", () => {
    // A clock stepped backwards must not buy an unbounded skip.
    expect(gate({ nowMs: T0 - 1 })).toEqual({ gather: true, reason: "floor" });
  });

  it("never throttles a kind that declares no stamp", () => {
    expect(gate({ stamp: null })).toEqual({ gather: true, reason: "no-stamp" });
    expect(gate({ stamp: null, last: null })).toEqual({
      gather: true,
      reason: "no-stamp",
    });
  });

  it("round-trips its stored record, and reads an unparseable one as ABSENT", () => {
    const r = { date: D, stamp: "abc123", at: T0 };
    expect(parseProseGatherRecord(formatProseGatherRecord(r))).toEqual(r);
    for (const bad of [
      "",
      "only-a-date",
      `${D}|abc123|not-a-number`,
      undefined,
    ])
      expect(parseProseGatherRecord(bad)).toBeNull();
    // …and ABSENT means the next tick rebuilds, never that it skips.
    expect(gate({ last: parseProseGatherRecord("junk") })).toEqual({
      gather: true,
      reason: "no-record",
    });
  });
});
