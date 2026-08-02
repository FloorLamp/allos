import { describe, it, expect } from "vitest";
import {
  countFragment,
  exposureFragment,
  mgLabel,
  prnOverMaxDetail,
  hoursLabel,
  prnLogAnswerText,
  prnQuickLogLabel,
  redoseActionIsPrimary,
  redoseCardLabel,
  redoseNoticeMessage,
} from "@/lib/redose-format";
import type { RedoseStatus } from "@/lib/prn-redose";
import { prnDayExposure } from "@/lib/prn-redose";

describe("redoseNoticeMessage", () => {
  it("renders the issue's example phrasing", () => {
    const m = redoseNoticeMessage({
      name: "Ibuprofen",
      sinceHours: 6,
      lastClock: "4:02pm",
      countToday: 2,
      maxDailyCount: 4,
    });
    expect(m.title).toBe("💊 Redose window open: Ibuprofen");
    expect(m.body).toBe(
      "6h since Ibuprofen (4:02pm) — your minimum interval has passed · 2 of 4 today."
    );
  });

  // #1721: the notice is safety-adjacent and lands in shared household chats, where
  // "whose ibuprofen interval passed?" must be answerable from the message itself.
  // Same self-attribution convention as refill/preventive/illness-care.
  it("names the subject profile in the title", () => {
    const m = redoseNoticeMessage({
      name: "Ibuprofen",
      profileName: "Ada",
      sinceHours: 6,
      lastClock: "4:02pm",
      countToday: 2,
      maxDailyCount: 4,
    });
    expect(m.title).toBe("💊 Redose window open: Ada — Ibuprofen");
  });

  it("leaves the title unattributed when no profile name is given", () => {
    const m = redoseNoticeMessage({
      name: "Ibuprofen",
      profileName: "  ",
      sinceHours: 6,
      lastClock: "",
      countToday: 1,
      maxDailyCount: 4,
    });
    expect(m.title).toBe("💊 Redose window open: Ibuprofen");
  });

  it("drops the clock parenthetical when unknown, never says 'you can take more'", () => {
    const m = redoseNoticeMessage({
      name: "Tylenol",
      sinceHours: 4,
      lastClock: "",
      countToday: 1,
      maxDailyCount: 6,
    });
    expect(m.body).not.toMatch(/\(/);
    expect(m.body.toLowerCase()).not.toContain("you can");
  });

  it("includes the saved formulation in the notice body", () => {
    const m = redoseNoticeMessage({
      name: "Acetaminophen",
      amount: "160 mg",
      product: "Children's oral suspension (160 mg / 5 mL)",
      sinceHours: 4,
      lastClock: "5:00 PM",
      countToday: 1,
      maxDailyCount: 5,
    });
    expect(m.body).toContain("Acetaminophen · 160 mg / 5 mL");
  });
});

describe("redoseCardLabel", () => {
  const status = (over: Partial<RedoseStatus>): RedoseStatus => ({
    open: false,
    atMax: false,
    countToday: 1,
    maxDailyCount: 4,
    sinceHours: 3,
    opensInHours: 3,
    exposure: null,
    ...over,
  });

  it("null status → null", () => {
    expect(redoseCardLabel(null)).toBeNull();
  });

  it("at max wins over open", () => {
    expect(
      redoseCardLabel(status({ open: true, atMax: true, countToday: 4 }))
    ).toBe("Max reached · 4 of 4 today");
  });

  it("open window", () => {
    expect(redoseCardLabel(status({ open: true, countToday: 2 }))).toBe(
      "Redose OK — min interval passed · 2 of 4 today"
    );
  });

  it("not yet open shows the countdown", () => {
    expect(redoseCardLabel(status({ open: false, opensInHours: 2 }))).toBe(
      "Next dose in ~2h · 1 of 4 today"
    );
  });

  // #1458 — the parent who filled in "6 hours" and left "maximum per day" blank.
  it("keeps the window guidance with no confirmed daily max", () => {
    const noMax = (over: Partial<RedoseStatus>) =>
      redoseCardLabel(status({ maxDailyCount: null, ...over }));
    expect(noMax({ open: false, opensInHours: 5, countToday: 1 })).toBe(
      "Next dose in ~5h · 1 today"
    );
    expect(noMax({ open: true, countToday: 1 })).toBe(
      "Redose OK — min interval passed · 1 today"
    );
  });

  it("never says 'Max reached' when no maximum was confirmed", () => {
    // atMax cannot be true without a max (redoseWindowStatus guarantees it), but the
    // formatter must not invent the phrase from a high count either.
    const label = redoseCardLabel(
      status({ open: true, maxDailyCount: null, countToday: 12 })
    );
    expect(label).toBe("Redose OK — min interval passed · 12 today");
    expect(label).not.toContain("Max reached");
    expect(label).not.toContain("of");
  });

  it("keeps the cross-item tail with no confirmed max", () => {
    expect(
      redoseCardLabel(status({ open: true, maxDailyCount: null }), 2)
    ).toBe("Redose OK — min interval passed · 1 today across 2 items");
  });

  it("reserves CTA emphasis for an open window below the daily max", () => {
    expect(redoseActionIsPrimary(null)).toBe(true);
    expect(redoseActionIsPrimary(status({ open: false }))).toBe(false);
    expect(redoseActionIsPrimary(status({ open: true }))).toBe(true);
    expect(redoseActionIsPrimary(status({ open: true, atMax: true }))).toBe(
      false
    );
  });
});

describe("helpers", () => {
  it("hoursLabel drops the decimal for whole hours", () => {
    expect(hoursLabel(6)).toBe("6h");
    expect(hoursLabel(6.5)).toBe("6.5h");
    expect(hoursLabel(-1)).toBe("0h");
  });
  it("countFragment", () => {
    expect(countFragment(2, 4)).toBe("2 of 4 today");
  });
});

// ---- The `/dose` quick-log list (issue #1717) ----
//
// The Telegram list rendered a bare item-only count while the gather already carried
// the interval, the confirmed max and the family counters — so a tap could pass the
// confirmed daily max with no warning, and a family-fed counter read "1 today" where
// the card said "3 of 4 today across 2 items". These pin that the list label IS the
// card's classification.
describe("prnQuickLogLabel (#1717)", () => {
  const status = (over: Partial<RedoseStatus> = {}): RedoseStatus => ({
    open: true,
    atMax: false,
    countToday: 2,
    maxDailyCount: 4,
    sinceHours: 7,
    opensInHours: 0,
    exposure: null,
    ...over,
  });

  it("states the same verdict the in-app card renders", () => {
    expect(
      prnQuickLogLabel({
        name: "Ibuprofen",
        dose: "200 mg",
        status: status(),
        countToday: 2,
        maxDailyCount: 4,
      })
    ).toBe(`Ibuprofen · 200 mg — ${redoseCardLabel(status())}`);
  });

  it("says Max reached at the confirmed daily max", () => {
    const label = prnQuickLogLabel({
      name: "Ibuprofen",
      dose: "200 mg",
      status: status({ countToday: 4, atMax: true }),
      countToday: 4,
      maxDailyCount: 4,
    });
    expect(label).toBe("Ibuprofen · 200 mg — Max reached · 4 of 4 today");
  });

  it("names the wait when the interval hasn't passed", () => {
    const label = prnQuickLogLabel({
      name: "Ibuprofen",
      dose: "200 mg",
      status: status({ open: false, countToday: 1, opensInHours: 2 }),
      countToday: 1,
      maxDailyCount: 4,
    });
    expect(label).toBe("Ibuprofen · 200 mg — Next dose in ~2h · 1 of 4 today");
  });

  it("counts the ingredient FAMILY, matching the card (#1027)", () => {
    const label = prnQuickLogLabel({
      name: "Ibuprofen Rx",
      dose: "600 mg",
      status: status({ countToday: 3 }),
      countToday: 3,
      maxDailyCount: 4,
      familyMemberCount: 2,
    });
    expect(label).toContain("3 of 4 today across 2 items");
  });

  it("never invents a ceiling that wasn't configured", () => {
    // No confirmed interval ⇒ no window status ⇒ the plain count fragment, and a null
    // max drops the ceiling half entirely (countFragment's discipline, #1458).
    const label = prnQuickLogLabel({
      name: "Tylenol",
      dose: "500 mg",
      status: null,
      countToday: 2,
      maxDailyCount: null,
    });
    expect(label).toBe("Tylenol · 500 mg — 2 today");
    expect(label).not.toContain("Max reached");
  });

  it("says nothing extra when nothing has been logged today", () => {
    expect(
      prnQuickLogLabel({
        name: "Tylenol",
        status: null,
        countToday: 0,
        maxDailyCount: 4,
      })
    ).toBe("Tylenol");
  });

  it("carries the multi-profile prefix", () => {
    expect(
      prnQuickLogLabel({
        name: "Tylenol",
        prefix: "Ada: ",
        status: null,
        countToday: 0,
        maxDailyCount: null,
      })
    ).toBe("Ada: Tylenol");
  });
});

describe("prnLogAnswerText (#1717)", () => {
  it("states the verdict that now stands after a logged tap", () => {
    expect(
      prnLogAnswerText(
        "Logged ✅ Ibuprofen — 5 today",
        true,
        {
          open: false,
          atMax: true,
          countToday: 5,
          maxDailyCount: 4,
          sinceHours: 0,
          opensInHours: 6,
          exposure: null,
        },
        1
      )
    ).toBe("Logged ✅ Ibuprofen — 5 today · Max reached · 5 of 4 today");
  });

  it("leaves a REFUSED tap's honest text alone — no verdict on a non-write", () => {
    expect(
      prnLogAnswerText(
        "Not logged — that med is out of date. Open the app.",
        false,
        null
      )
    ).toBe("Not logged — that med is out of date. Open the app.");
  });

  it("adds nothing when there is no window to report", () => {
    expect(prnLogAnswerText("Logged ✅ Tylenol", true, null)).toBe(
      "Logged ✅ Tylenol"
    );
  });
});

// ---- Amount-aware fragments + the over-max finding copy (#1854) -------------

describe("exposureFragment (#1854)", () => {
  it("reads milligrams on the mg basis", () => {
    expect(
      exposureFragment(
        prnDayExposure({
          amounts: ["800 mg", "400 mg"],
          maxDailyAmountMg: 2400,
          maxDailyCount: 6,
        }),
        2,
        6
      )
    ).toBe("1200 of 2400 mg today");
  });

  it("says 'at least' on the mg lower bound — never full precision it doesn't have", () => {
    expect(
      exposureFragment(
        prnDayExposure({
          amounts: ["800 mg", "1 tablet"],
          maxDailyAmountMg: 1200,
          maxDailyCount: null,
        }),
        2,
        null
      )
    ).toBe("at least 800 of 1200 mg today");
  });

  it("falls back to the plain count fragment on the count basis and with no exposure", () => {
    expect(
      exposureFragment(
        prnDayExposure({
          amounts: ["800 mg", "1 tablet"],
          maxDailyAmountMg: 1200,
          maxDailyCount: 4,
        }),
        2,
        4
      )
    ).toBe("2 of 4 today");
    expect(exposureFragment(null, 2, 4)).toBe("2 of 4 today");
    expect(exposureFragment(null, 2, null)).toBe("2 today");
  });
});

describe("mgLabel", () => {
  it("keeps at most one decimal and drops trailing zeros", () => {
    expect(mgLabel(2400)).toBe("2400");
    expect(mgLabel(0.5)).toBe("0.5");
    expect(mgLabel(333.333)).toBe("333.3");
  });
});

describe("redoseCardLabel × exposure (#1854)", () => {
  it("the card's Max reached verdict and fragment both follow the mg basis", () => {
    const exposure = prnDayExposure({
      amounts: ["800 mg", "800 mg", "800 mg"],
      maxDailyAmountMg: 1200,
      maxDailyCount: 6,
    });
    const s: RedoseStatus = {
      open: true,
      atMax: exposure!.atMax,
      countToday: 3,
      maxDailyCount: 6,
      sinceHours: 7,
      opensInHours: 0,
      exposure,
    };
    expect(redoseCardLabel(s, 2)).toBe(
      "Max reached · 2400 of 1200 mg today across 2 items"
    );
  });
});

describe("prnOverMaxDetail (#1854)", () => {
  it("mg basis, family: milligrams stated, members named, ceiling in mg/day", () => {
    const d = prnOverMaxDetail({
      basis: "mg",
      total: 2400,
      max: 1200,
      unknownAmounts: 0,
      memberNames: ["Ibuprofen", "Ibuprofen 800 mg"],
    });
    expect(d).toContain("2400 mg logged today");
    expect(d).toContain("summed from your logged dose amounts");
    expect(d).toContain("across Ibuprofen + Ibuprofen 800 mg");
    expect(d).toContain("most conservative confirmed max of 1200 mg per day");
    expect(d).toContain("Informational");
  });

  it("mg lower bound reads 'At least' and counts the amount-less doses", () => {
    const d = prnOverMaxDetail({
      basis: "mg",
      total: 1600,
      max: 1200,
      unknownAmounts: 2,
    });
    expect(d).toContain("At least 1600 mg logged today");
    expect(d).toContain("(2 doses had no recorded amount)");
    expect(d).not.toContain("summed from");
  });

  it("count basis states doses — never implying mg precision", () => {
    const d = prnOverMaxDetail({
      basis: "count",
      total: 5,
      max: 4,
      unknownAmounts: 0,
    });
    expect(d).toContain(
      "5 doses logged today vs your confirmed max of 4 per day"
    );
    expect(d).not.toContain("mg");
  });

  it("the notice body phrases the same mg basis (one computation)", () => {
    const m = redoseNoticeMessage({
      name: "Ibuprofen",
      sinceHours: 6,
      lastClock: "4:02pm",
      countToday: 1,
      maxDailyCount: 6,
      exposure: prnDayExposure({
        amounts: ["800 mg"],
        maxDailyAmountMg: 2400,
        maxDailyCount: 6,
      }),
    });
    expect(m.body).toContain("800 of 2400 mg today");
  });
});
