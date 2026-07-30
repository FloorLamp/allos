// PURE TIER — the household dose round's message rendering, callback token, and
// stored-selection serialization (issue #1459). No DB: the formatter takes
// pre-gathered per-member sections, which is exactly the split that makes it testable
// here (the builder's own input layer gets a DB-tier fixture instead).
//
// Fixtures are synthetic household names and made-up supplements. No PHI.

import { describe, it, expect } from "vitest";
import {
  HOUSEHOLD_ROUND_MAX_BUTTONS,
  householdDoseLabel,
  householdRoundDoseCount,
  parseHouseholdRoundMembers,
  renderHouseholdRoundMessage,
  serializeHouseholdRoundMembers,
  type HouseholdRoundSection,
} from "@/lib/notifications/household-round-format";
import {
  householdDoseCallback,
  householdTapAnswerText,
  householdTapRefusalText,
  parseHouseholdDoseCallback,
} from "@/lib/notifications/callback-data";

const BASE = "https://allos.example";
const HOUSEHOLD = "/household";

function section(
  over: Partial<HouseholdRoundSection> = {}
): HouseholdRoundSection {
  return {
    profileId: 7,
    name: "Ada",
    date: "2026-07-25",
    doses: [
      { doseId: 100, itemId: 50, itemName: "Vitamin D3", amount: "2000 IU" },
    ],
    ...over,
  };
}

const render = (sections: HouseholdRoundSection[]) =>
  renderHouseholdRoundMessage({
    receiverProfileId: 1,
    sections,
    base: BASE,
    householdHref: HOUSEHOLD,
  });

describe("renderHouseholdRoundMessage", () => {
  it("EMPTY ROUND SENDS NOTHING", () => {
    // The load-bearing negative: a caregiver must never be pinged to be told there
    // is nothing to do.
    expect(render([])).toBeNull();
    expect(render([section({ doses: [] })])).toBeNull();
  });

  it("omits members with nothing due, keeping the ones that have doses", () => {
    const msg = render([
      section({ profileId: 7, name: "Ada" }),
      section({ profileId: 9, name: "Kai", doses: [] }),
    ])!;
    expect(msg.body).toContain("Ada");
    expect(msg.body).not.toContain("Kai");
    expect(msg.title).toContain("1 member");
  });

  it("renders one section per member with a line per dose", () => {
    const msg = render([
      section({
        profileId: 7,
        name: "Ada",
        doses: [
          {
            doseId: 100,
            itemId: 50,
            itemName: "Vitamin D3",
            amount: "2000 IU",
          },
          { doseId: 101, itemId: 51, itemName: "Iron", amount: null },
        ],
      }),
      section({
        profileId: 9,
        name: "Kai",
        doses: [
          { doseId: 200, itemId: 60, itemName: "Melatonin", amount: "3 mg" },
        ],
      }),
    ])!;
    expect(msg.title).toBe("💊 Household doses — 3 due across 2 members");
    expect(msg.body).toBe(
      [
        "Ada:",
        "• Vitamin D3 · 2000 IU",
        "• Iron",
        "",
        "Kai:",
        "• Melatonin · 3 mg",
      ].join("\n")
    );
  });

  it("is dose-class so it inherits the safety tier's routing", () => {
    // Deliberately reuses `kind: "dose"` (the #924 precedent) rather than minting a
    // parallel kind that would have to re-derive safety routing and toggles.
    expect(render([section()])!.kind).toBe("dose");
  });

  it("mints one confirm button per dose, grouped by member, ids only", () => {
    const msg = render([
      section({
        profileId: 7,
        name: "Ada",
        doses: [
          {
            doseId: 100,
            itemId: 50,
            itemName: "Vitamin D3",
            amount: "2000 IU",
          },
          { doseId: 101, itemId: 51, itemName: "Iron", amount: null },
        ],
      }),
      section({
        profileId: 9,
        name: "Kai",
        date: "2026-07-26",
        doses: [
          { doseId: 200, itemId: 60, itemName: "Melatonin", amount: "3 mg" },
        ],
      }),
    ])!;
    // Three confirm buttons plus the ride-along deep link (#1718).
    const actions = msg.actions!.filter((a) => !a.url);
    expect(actions).toHaveLength(3);
    expect(actions[0].label).toBe("✓ Ada · Vitamin D3 · 2000 IU");
    // Rows group by member, so a member's doses share a row and two members never do.
    expect(actions[0].row).toBe(actions[1].row);
    expect(actions[0].row).not.toBe(actions[2].row);
    // Tokens carry ids only — never a name.
    expect(actions[0].data).toBe("hh:1:7:100:50:2026-07-25");
    expect(actions.every((a) => !/Ada|Kai|Vitamin/.test(a.data ?? ""))).toBe(
      true
    );
  });

  it("stamps each member's OWN date on their tokens, not the receiver's", () => {
    // The two-timezone case: a round assembled at one slot can span two dates.
    const msg = render([
      section({ profileId: 7, name: "Ada", date: "2026-07-25" }),
      section({
        profileId: 9,
        name: "Kai",
        date: "2026-07-26",
        doses: [
          { doseId: 200, itemId: 60, itemName: "Melatonin", amount: "3 mg" },
        ],
      }),
    ])!;
    expect(msg.actions![0].data).toContain(":2026-07-25");
    expect(msg.actions![1].data).toContain(":2026-07-26");
  });

  it("collapses past the cap to a single Household deep link", () => {
    const doses = Array.from(
      { length: HOUSEHOLD_ROUND_MAX_BUTTONS + 1 },
      (_, i) => ({
        doseId: 300 + i,
        itemId: 400 + i,
        itemName: `Item ${i}`,
        amount: null,
      })
    );
    const msg = render([section({ doses })])!;
    expect(msg.actions).toEqual([
      { label: "Open Household →", url: `${BASE}${HOUSEHOLD}` },
    ]);
    // The body still lists everything — only the keyboard degrades.
    expect(msg.body).toContain("Item 0");
  });

  it("carries no buttons at all when the overflow link has no public URL", () => {
    const doses = Array.from(
      { length: HOUSEHOLD_ROUND_MAX_BUTTONS + 1 },
      (_, i) => ({
        doseId: 300 + i,
        itemId: 400 + i,
        itemName: `Item ${i}`,
        amount: null,
      })
    );
    const msg = renderHouseholdRoundMessage({
      receiverProfileId: 1,
      sections: [section({ doses })],
      base: "",
      householdHref: HOUSEHOLD,
    })!;
    expect(msg.actions).toBeUndefined();
  });

  it("keeps buttons exactly AT the cap", () => {
    const doses = Array.from(
      { length: HOUSEHOLD_ROUND_MAX_BUTTONS },
      (_, i) => ({
        doseId: 300 + i,
        itemId: 400 + i,
        itemName: `Item ${i}`,
        amount: null,
      })
    );
    const msg = render([section({ doses })])!;
    expect(msg.actions!.filter((a) => !a.url)).toHaveLength(
      HOUSEHOLD_ROUND_MAX_BUTTONS
    );
  });

  // #1718: under the cap the round used to carry confirm buttons ONLY, so the Web
  // Push and Home Assistant copies arrived naming members and items with no way to
  // confirm and no way to open the page. The over-cap path already degraded to this
  // link; the under-cap path needs it ALONGSIDE the buttons.
  it("carries the household deep link alongside its confirm buttons", () => {
    const msg = render([section()])!;
    const link = msg.actions!.find((a) => a.url);
    expect(link?.url).toBe(`${BASE}${HOUSEHOLD}`);
    expect(link?.label).toBe("Open Household →");
    // The confirm buttons are untouched — the link is additive.
    expect(msg.actions!.some((a) => a.data?.startsWith("hh:"))).toBe(true);
  });

  it("omits the link when no public URL is configured, keeping the buttons", () => {
    const msg = renderHouseholdRoundMessage({
      receiverProfileId: 1,
      sections: [section()],
      base: "",
      householdHref: HOUSEHOLD,
    })!;
    expect(msg.actions!.every((a) => !a.url)).toBe(true);
    expect(msg.actions!.length).toBeGreaterThan(0);
  });
});

describe("householdDoseLabel / householdRoundDoseCount", () => {
  it("appends the amount only when there is one", () => {
    expect(
      householdDoseLabel({
        doseId: 1,
        itemId: 2,
        itemName: "Iron",
        amount: " 65 mg ",
      })
    ).toBe("Iron · 65 mg");
    expect(
      householdDoseLabel({ doseId: 1, itemId: 2, itemName: "Iron", amount: "" })
    ).toBe("Iron");
    expect(
      householdDoseLabel({
        doseId: 1,
        itemId: 2,
        itemName: "Iron",
        amount: null,
      })
    ).toBe("Iron");
  });

  it("counts doses across every section", () => {
    expect(
      householdRoundDoseCount([
        section(),
        section({
          profileId: 9,
          doses: [
            { doseId: 2, itemId: 3, itemName: "A", amount: null },
            { doseId: 3, itemId: 4, itemName: "B", amount: null },
          ],
        }),
      ])
    ).toBe(3);
  });
});

describe("household dose callback token", () => {
  it("round-trips", () => {
    const cb = {
      receiverProfileId: 1,
      memberProfileId: 7,
      doseId: 100,
      itemId: 50,
      date: "2026-07-25",
    };
    expect(parseHouseholdDoseCallback(householdDoseCallback(cb))).toEqual(cb);
  });

  it("rejects malformed tokens", () => {
    expect(parseHouseholdDoseCallback(null)).toBeNull();
    expect(parseHouseholdDoseCallback("take:1:2:3:2026-07-25")).toBeNull();
    expect(parseHouseholdDoseCallback("hh:1:7:100:50")).toBeNull(); // no date
    expect(parseHouseholdDoseCallback("hh:x:7:100:50:2026-07-25")).toBeNull();
    expect(parseHouseholdDoseCallback("hh:1:7:0:50:2026-07-25")).toBeNull();
  });

  it("rejects a self-referential token — the round is cross-profile by construction", () => {
    expect(parseHouseholdDoseCallback("hh:7:7:100:50:2026-07-25")).toBeNull();
  });

  it("stays inside Telegram's 64-byte callback limit for plausible ids", () => {
    const token = householdDoseCallback({
      receiverProfileId: 999999,
      memberProfileId: 999999,
      doseId: 9999999,
      itemId: 9999999,
      date: "2026-07-25",
    });
    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("household tap answers", () => {
  it("never confirms a refusal, and names what actually happened", () => {
    for (const kind of ["wrong-chat", "unsubscribed", "revoked"] as const) {
      const text = householdTapRefusalText({ kind });
      expect(text).toMatch(/^Not logged/);
      expect(text).not.toContain("✅");
    }
    // Each refusal is distinguishable — a caregiver can tell "you lost access" from
    // "this reminder is stale".
    expect(householdTapRefusalText({ kind: "revoked" })).not.toBe(
      householdTapRefusalText({ kind: "unsubscribed" })
    );
  });

  it("names the member on a logged confirm, per markDoseTaken's outcome", () => {
    expect(householdTapAnswerText("Ada", "logged")).toBe("Ada: Logged ✅");
    expect(householdTapAnswerText("Ada", "already-taken")).toBe(
      "Ada: Logged ✅"
    );
    // Nothing was written — the answer must not be dressed up as a confirm.
    expect(householdTapAnswerText("Ada", "inactive")).not.toContain("✅");
    expect(householdTapAnswerText("Ada", "stale-dose")).not.toContain("✅");
    expect(householdTapAnswerText("Ada", "already-skipped")).not.toContain(
      "✅"
    );
  });
});

describe("stored member selection", () => {
  it("parses, dedupes and sorts a well-formed list", () => {
    expect(parseHouseholdRoundMembers("[9,7,9]")).toEqual([7, 9]);
  });

  it("degrades to empty rather than throwing on junk (the tick must not crash)", () => {
    expect(parseHouseholdRoundMembers(undefined)).toEqual([]);
    expect(parseHouseholdRoundMembers("")).toEqual([]);
    expect(parseHouseholdRoundMembers("not json")).toEqual([]);
    expect(parseHouseholdRoundMembers('{"a":1}')).toEqual([]);
    expect(parseHouseholdRoundMembers('[0,-3,"x",null,2.5]')).toEqual([]);
  });

  it("round-trips through serialize", () => {
    expect(
      parseHouseholdRoundMembers(serializeHouseholdRoundMembers([9, 7]))
    ).toEqual([7, 9]);
    expect(serializeHouseholdRoundMembers([])).toBe("[]");
  });
});
