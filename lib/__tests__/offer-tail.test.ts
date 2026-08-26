// PURE TIER — the slot-hint reading of a `may` item's time_of_day (#1505) and the
// digest's "➕ Doses" tail built on top of it.
//
// The load-bearing property under test is that scoping is a function of the CURRENT
// clock, not of when a message was built. Everything else here is copy and shape.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";
import {
  isOfferedOn,
  slotHintBucket,
  slotHintCoversNow,
} from "@/lib/intake-schedule";
import {
  collapsedOfferAction,
  reminderOfferAction,
  expandedOfferActions,
  offerTailNeedsRefresh,
  offerTextTail,
  OFFER_COLLAPSE_PREFIX,
  OFFER_EXPAND_PREFIX,
} from "@/lib/notifications/offer-tail";
import { collapsedTuneAction } from "@/lib/notifications/digest-tune";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import {
  capTelegramKeyboard,
  TELEGRAM_MAX_BUTTONS,
} from "@/lib/notifications/telegram-limits";
import type {
  NotificationAction,
  NotificationMessage,
} from "@/lib/notifications/types";

const ctx = {
  date: "2026-03-04",
  isWorkoutDay: false,
  activeSituations: new Set<string>(),
};

describe("slotHintBucket", () => {
  it("reads a real hint, and reads none from an anytime/absent slot", () => {
    expect(slotHintBucket("Before sleep")).toBe("Before sleep");
    expect(slotHintBucket("morning")).toBe("Morning");
    expect(slotHintBucket("Anytime")).toBeNull();
    expect(slotHintBucket(null)).toBeNull();
    // Free text still maps through the shared bucketer.
    expect(slotHintBucket("with dinner")).toBe("Evening");
  });
});

describe("slotHintCoversNow", () => {
  it("offers a hinted item only inside its own slot", () => {
    expect(slotHintCoversNow("Before sleep", "22:30")).toBe(true);
    expect(slotHintCoversNow("Before sleep", "08:00")).toBe(false);
    expect(slotHintCoversNow("morning", "08:00")).toBe(true);
    expect(slotHintCoversNow("morning", "22:30")).toBe(false);
  });

  it("offers a HINT-LESS item in every slot — the aspirin case", () => {
    // No hint means no opinion. Refusing to show it anywhere would make "may with
    // no slot" unreachable, which is the opposite of the guaranteed-access rule.
    for (const t of ["06:00", "12:00", "18:00", "23:30"]) {
      expect(slotHintCoversNow(null, t)).toBe(true);
      expect(slotHintCoversNow("Anytime", t)).toBe(true);
    }
  });

  it("is a function of NOW, so one item answers differently across the day", () => {
    // This is the whole reason the expansion re-evaluates at tap: a digest is born in
    // the morning and its keyboard may be tapped at bedtime.
    expect(slotHintCoversNow("Before sleep", "09:00")).toBe(false);
    expect(slotHintCoversNow("Before sleep", "23:00")).toBe(true);
  });
});

describe("isOfferedOn", () => {
  it("offers only `may` items, and only when their day condition applies", () => {
    const may = {
      obligation: "may" as const,
      condition: "daily" as const,
      situation: null,
    };
    expect(isOfferedOn(may, ctx)).toBe(true);
    // A must/should item is DUE, not offered — it belongs to the other list.
    expect(isOfferedOn({ ...may, obligation: "should" as const }, ctx)).toBe(
      false
    );
    expect(isOfferedOn({ ...may, obligation: "must" as const }, ctx)).toBe(
      false
    );
  });

  it("respects the day condition — a rest-day item is not offered on a training day", () => {
    const restDay = {
      obligation: "may" as const,
      condition: "rest_day" as const,
      situation: null,
    };
    expect(isOfferedOn(restDay, ctx)).toBe(true);
    expect(isOfferedOn(restDay, { ...ctx, isWorkoutDay: true })).toBe(false);
  });

  it("respects a situational hold — a paused item is not one tap away either", () => {
    const held = {
      obligation: "may" as const,
      condition: "daily" as const,
      situation: null,
      pause_situation: "Pre-surgery",
    };
    expect(isOfferedOn(held, ctx)).toBe(true);
    expect(
      isOfferedOn(held, { ...ctx, activeSituations: new Set(["Pre-surgery"]) })
    ).toBe(false);
  });
});

describe("the collapsed tail", () => {
  // #2890: the label names the THING it opens — the app's own noun for what these
  // buttons write — and states how many are behind it. It replaces #1819 item 8's
  // "Log other (3 for bedtime)", whose noun was relative to a list the reader may not
  // be able to see, and whose slot word the expansion restates the moment it opens.
  it("names the doses it opens, and how many are on offer", () => {
    const a = collapsedOfferAction(7, "2026-07-29", 3);
    expect(a.label).toBe("➕ Doses (3)");
    expect(a.data).toBe(`${OFFER_EXPAND_PREFIX}:7:2026-07-29`);
  });

  it("drops the parenthetical when there is no count to state", () => {
    expect(collapsedOfferAction(7, "2026-07-29", 0).label).toBe("➕ Doses");
    // Never "(0)" — no count, rather than a count of none.
    expect(collapsedOfferAction(7, "2026-07-29", 0).label).not.toContain("0");
  });

  // The slot is still what SCOPES the offer (the caller reads the profile-local clock
  // to build `count`); it is no longer what the label spends its width on.
  it("names no slot in either state", () => {
    for (const label of [
      collapsedOfferAction(7, "2026-07-29", 3).label,
      collapsedOfferAction(7, "2026-07-29", 0).label,
    ]) {
      for (const slot of ["morning", "midday", "evening", "bedtime"]) {
        expect(label.toLowerCase()).not.toContain(slot);
      }
    }
  });

  // The label is now a function of the COUNT alone, and the count is what the
  // boundary refresh re-reads — so a boundary that moves it still re-labels.
  it("re-labels when the slot boundary changes what is on offer", () => {
    expect(collapsedOfferAction(7, "2026-07-29", 1).label).not.toBe(
      collapsedOfferAction(7, "2026-07-29", 2).label
    );
  });

  // ---- …but the DOSE REMINDER keeps "other" (#2890) ----
  //
  // The reminder's keyboard already carries "✅ All (N)" over the doses it is
  // reminding about. A second bare dose count beside it is two numbers that mean
  // different things and cannot be added up — and the argument for dropping the noun
  // was digest-only, because on the reminder the referent is the message itself.
  it("keeps the noun 'other' on the reminder, where the referent is visible", () => {
    expect(reminderOfferAction(7, "2026-07-29", 3).label).toBe(
      "➕ Log other (3)"
    );
    expect(reminderOfferAction(7, "2026-07-29", 0).label).toBe("➕ Log other");
  });

  it("names no slot on the reminder either — the reminder IS the slot", () => {
    const label = reminderOfferAction(7, "2026-07-29", 3).label.toLowerCase();
    for (const slot of ["morning", "midday", "evening", "bedtime"]) {
      expect(label).not.toContain(slot);
    }
  });

  it("opens the same expansion as the digest control — one token, two labels", () => {
    expect(reminderOfferAction(7, "2026-07-29", 3).data).toBe(
      collapsedOfferAction(7, "2026-07-29", 3).data
    );
  });

  // It has no ⚙️ Tune to pair with, so it must not claim the shared row key: a future
  // control landing beside it would otherwise be dragged onto its row.
  it("does not carry the digest tail's shared row key", () => {
    expect(reminderOfferAction(7, "2026-07-29", 3).row).toBeUndefined();
  });
});

// ---- The two collapsed controls share ONE keyboard row (#2890) ----
//
// They are always assembled adjacent (`[offerTail, tuneTail, …]` on the digest, and
// the same order in every keyboard rebuild), and two small controls had no business
// claiming a full-width row each. `messageKeyboard` already merges consecutive actions
// sharing a `row` key (#232) — these two simply never declared the same one.
describe("the collapsed tail pairs with ⚙️ Tune (#2890)", () => {
  const keyboard = (actions: NotificationAction[]) =>
    messageKeyboard({ title: "", body: "", actions });

  it("renders the pair as one row of two buttons", () => {
    const rows = keyboard([
      collapsedOfferAction(7, "2026-07-29", 3),
      collapsedTuneAction(7, "2026-07-29"),
    ]);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ["➕ Doses (3)", "⚙️ Tune"],
    ]);
  });

  // The shared key must not depend on the partner being present: grouping is by
  // ADJACENCY, so a digest carrying only one of them still renders one button.
  it("renders a single button when either control is alone", () => {
    expect(keyboard([collapsedOfferAction(7, "2026-07-29", 3)])).toEqual([
      [expect.objectContaining({ text: "➕ Doses (3)" })],
    ]);
    expect(keyboard([collapsedTuneAction(7, "2026-07-29")])).toEqual([
      [expect.objectContaining({ text: "⚙️ Tune" })],
    ]);
  });

  // The EXPANDED offer list is a different layout, and keeps its own keys: a Tune
  // button appended after its ▲ Collapse must not be dragged onto that row.
  it("does not merge the expanded list's ▲ Collapse with ⚙️ Tune", () => {
    const rows = keyboard([
      ...expandedOfferActions(
        7,
        "2026-07-29",
        [{ itemId: 11, name: "Magnesium (test)", detail: null, countToday: 0 }],
        () => "tok"
      ),
      collapsedTuneAction(7, "2026-07-29"),
    ]);
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1]);
  });
});

describe("the expanded tail", () => {
  // #2858 review pass 2, R1. Every button here logs an administration, so two
  // reading alike over two different item ids is a wrong-subject tap. Resolved
  // over the offered set this keyboard renders.
  it("never labels two offer buttons alike", () => {
    const actions = expandedOfferActions(
      7,
      "2026-07-29",
      [
        { itemId: 11, name: "Coenzyme Q10", detail: null, countToday: 0 },
        { itemId: 12, name: "Ubiquinone", detail: null, countToday: 0 },
      ],
      () => "tok"
    );
    const labels = actions
      .filter((a) => a.data?.startsWith("prn:"))
      .map((a) => a.label);
    expect(labels).toEqual(["💊 Coenzyme Q10", "💊 Ubiquinone"]);
  });

  it("still shortens a lone offer button", () => {
    const actions = expandedOfferActions(
      7,
      "2026-07-29",
      [{ itemId: 11, name: "Coenzyme Q10", detail: null, countToday: 0 }],
      () => "tok"
    );
    expect(actions.find((a) => a.data?.startsWith("prn:"))!.label).toBe(
      "💊 CoQ10"
    );
  });

  const items = [
    { itemId: 11, name: "Magnesium (test)", detail: "200 mg", countToday: 0 },
    { itemId: 12, name: "Aspirin (test)", detail: null, countToday: 2 },
  ];

  it("logs through the SAME prn token the /dose command uses", () => {
    const actions = expandedOfferActions(7, "2026-07-29", items, () => "tok");
    expect(actions[0].data).toBe("prn:7:11:tok");
    expect(actions[1].data).toBe("prn:7:12:tok");
  });

  it("shows today's count so a re-tap is informed, and ends with a collapse", () => {
    const actions = expandedOfferActions(7, "2026-07-29", items, () => "tok");
    expect(actions[0].label).toContain("200 mg");
    expect(actions[0].label).not.toContain("today");
    expect(actions[1].label).toContain("(2 today)");
    expect(actions.at(-1)!.data).toBe(`${OFFER_COLLAPSE_PREFIX}:7:2026-07-29`);
  });

  it("labels a supplement by its shorter product name when it has one", () => {
    const actions = expandedOfferActions(
      7,
      "2026-07-29",
      [
        {
          itemId: 13,
          name: "Astaxanthin/Lutein/Zeaxanthin (test)",
          kind: "supplement" as const,
          product: "Eye Health+",
          detail: "1 cap",
          countToday: 0,
        },
      ],
      () => "tok"
    );
    expect(actions[0].label).toBe("💊 Eye Health+ · 1 cap");
  });
});

describe("offerTextTail (the channels that cannot expand)", () => {
  // #1712: "+3 available when you want them" never said available WHAT. The line
  // names the noun now, and exists only for the channels with no button to carry it.
  it("names the noun, handles singular/plural, and says nothing at zero", () => {
    expect(offerTextTail(0)).toBeNull();
    expect(offerTextTail(1)).toBe("1 more supplement you can log any time");
    expect(offerTextTail(3)).toBe("3 more supplements you can log any time");
  });
});

describe("offerTailNeedsRefresh", () => {
  it("is true only across a slot boundary, so a quiet tick makes no API call", () => {
    expect(offerTailNeedsRefresh("08:00", "09:30")).toBe(false);
    expect(offerTailNeedsRefresh("08:00", "22:30")).toBe(true);
    expect(offerTailNeedsRefresh("22:00", "23:30")).toBe(false);
  });
});

// ── THE `prn:` DISCRIMINATOR IS KEYBOARD-SHAPED, SO THE KEYBOARD MUST HOLD (#3567) ──
//
// `prn:` is minted by BOTH the `/dose` command's list and the digest's expanded offer
// list, on purpose: one administration-logging path on Telegram rather than two that
// could drift. So the BUTTON cannot say which keyboard offered it, and
// `isExpandedOfferKeyboard` (lib/notifications/telegram-quick-log.ts) asks the
// KEYBOARD instead — an expanded offer list is the only one carrying a collapse token.
//
// That is the right call: it works on messages minted before the marker mechanism
// shipped, which a token marker never could. But it rests on an invariant NOTHING
// ASSERTED — that every `prn:` keyboard which is an offer list carries a collapse
// control. Lose it and the list reads as `/dose`: silently, because "a /dose tap" is a
// perfectly valid reading that stamps `telegram-command` and skips the chip rebuild.
//
// Two halves, because the invariant has two ways to break:
//   1. `expandedOfferActions` stops appending the control — asserted below, directly.
//   2. A THIRD site starts minting `prn:` and never thinks about the discriminator —
//      caught by the census, which pins the minter set at exactly the two that exist.

const PRN_MINTERS: Record<string, string> = {
  "lib/notifications/offer-tail.ts":
    "the digest's expanded offer list; `expandedOfferActions` appends the collapse " +
    "control to every list it renders, which is what makes the keyboard readable",
  "lib/notifications/telegram-quick-log.ts":
    "the `/dose` command's reusable list, which has never had a collapse control — " +
    "it is the OTHER side of the discriminator, and must stay that way",
};

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Every non-test source file under `root` minting a `prn:` callback token.
 *
 * Takes a ROOT so the reach test below can run this whole walker over a corpus
 * written to break it — a census proved only against a complying tree has proved
 * that the tree complies, not that the census can see.
 */
function prnMinters(root: string = REPO_ROOT): string[] {
  const roots = ["lib", "app"];
  const out: string[] = [];
  const walkDir = (dir: string, base: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walkDir(p, base);
        continue;
      }
      if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
      const rel = path.relative(base, p).split(path.sep).join("/");
      if (/__(?:db_|action_)?tests__/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(p)) continue;
      // COMMENTS STRIPPED FIRST. Five of the seven `` `prn: `` occurrences in this
      // tree are PROSE about the shared prefix — a raw text sweep would report the
      // modules that merely explain the mechanism as if they minted tokens, and the
      // registry would then be a list of documentation.
      if (/`prn:/.test(stripComments(fs.readFileSync(p, "utf8"))))
        out.push(rel);
    }
  };
  for (const r of roots) walkDir(path.join(root, r), root);
  return [...new Set(out)].sort();
}

describe("the prn: keyboard discriminator", () => {
  it("appends a collapse control to EVERY expanded offer list", () => {
    // The property `isExpandedOfferKeyboard` reads. Spelled here as the same
    // prefix test rather than by importing that function: it lives in a module that
    // reaches the database, and this is the pure tier.
    const carries = (actions: NotificationAction[]): boolean =>
      actions.some((a) => a.data?.startsWith(`${OFFER_COLLAPSE_PREFIX}:`));
    for (const n of [1, 2, 7, 40]) {
      const items = Array.from({ length: n }, (_, i) => ({
        itemId: i + 1,
        name: `Item ${i + 1}`,
        detail: null,
        countToday: 0,
      }));
      const actions = expandedOfferActions(7, "2026-03-04", items, () => "tok");
      expect(actions.filter((a) => a.data?.startsWith("prn:"))).toHaveLength(n);
      expect(carries(actions), `${n} offered items`).toBe(true);
    }
  });

  it("mints prn: from exactly the two keyboards that own the discriminator", () => {
    expect(
      prnMinters(),
      "A source file mints a `prn:` callback token and is not one of the two " +
        "keyboards this discriminator is built on (#3567 item 7). `prn:` says " +
        "nothing about which keyboard offered it — the COLLAPSE CONTROL does. If the " +
        "new keyboard is an offer list, it must carry one; if it is a command list, " +
        "it must not. Then add a line to PRN_MINTERS saying which it is."
    ).toEqual(Object.keys(PRN_MINTERS).sort());
  });

  it("loses the control ONLY at the wire cap, and says at which count", () => {
    // THE ONE MECHANICAL ROUTE, measured rather than asserted away. `sendMessageRaw`
    // puts `capTelegramKeyboard(messageKeyboard(msg))` on the wire, and the cap keeps
    // whole LEADING rows — so the collapse control, which is appended LAST, is the
    // first thing dropped. Every offered item takes a row of its own (`row:
    // offer-<itemId>`) and the control takes one more, so the list survives at
    // TELEGRAM_MAX_BUTTONS - 1 items and loses its control at TELEGRAM_MAX_BUTTONS.
    //
    // A keyboard past that point reads as `/dose`. It needs ~100 offered doses in ONE
    // slot, which is why this is a bound and not a bug report — but it is written
    // down, and it turns red if the cap arithmetic or the row grouping changes.
    const list = (n: number) => {
      const items = Array.from({ length: n }, (_, i) => ({
        itemId: i + 1,
        name: `Item ${i + 1}`,
        detail: null,
        countToday: 0,
      }));
      const msg: NotificationMessage = {
        title: "Doses",
        body: "x",
        actions: expandedOfferActions(7, "2026-03-04", items, () => "tok"),
      };
      return capTelegramKeyboard(messageKeyboard(msg)).keyboard;
    };
    const hasCollapse = (rows: ReturnType<typeof list>): boolean =>
      rows.some((r) =>
        r.some((b) =>
          ("callback_data" in b ? (b.callback_data ?? "") : "").startsWith(
            `${OFFER_COLLAPSE_PREFIX}:`
          )
        )
      );
    expect(hasCollapse(list(TELEGRAM_MAX_BUTTONS - 1))).toBe(true);
    expect(hasCollapse(list(TELEGRAM_MAX_BUTTONS))).toBe(false);
  });

  it("SEES a third minter, and stays SILENT on prose about the prefix", () => {
    const root = makeTmpDir("prn-minters");
    const write = (rel: string, body: string): void => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    // A third keyboard minting the token — the finding.
    write(
      "lib/notifications/new-keyboard.ts",
      "export const btn = { data: `prn:${pid}:${id}:${tok()}` };\n"
    );
    // Prose about the shared prefix, which is what most `prn:` occurrences in this
    // tree actually are. Reporting these would make the registry a list of docs.
    write(
      "lib/notifications/explainer.ts",
      "// `prn:` is shared by the two lists; see the discriminator.\n" +
        "export const NOTE = 1;\n"
    );
    // A READER of the token, not a minter: a double-quoted prefix test. Named
    // `readsPrnToken` rather than the retired generic spelling that
    // lib/__tests__/current-vocabulary.test.ts holds the tree away from — a fixture
    // is current source too, and that guard was right to say so.
    write(
      "lib/notifications/reader.ts",
      'export const readsPrnToken = (d: string) => d.startsWith("prn:");\n'
    );
    // And a test file, excluded by suffix even though it mints the same shape.
    write(
      "lib/__tests__/x.test.ts",
      "const d = `prn:1:2:tok`;\n"
    );
    expect(prnMinters(root)).toEqual(["lib/notifications/new-keyboard.ts"]);
  });
});
