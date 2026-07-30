import { describe, it, expect } from "vitest";
import {
  redoseNoticeMessage,
  redoseActionIsPrimary,
  redoseCardLabel,
  hoursLabel,
  countFragment,
} from "@/lib/redose-format";
import type { RedoseStatus } from "@/lib/prn-redose";

describe("redoseNoticeMessage", () => {
  it("renders the issue's example phrasing", () => {
    const m = redoseNoticeMessage({
      name: "Ibuprofen",
      sinceHours: 6,
      lastClock: "4:02pm",
      countToday: 2,
      maxDailyCount: 4,
    });
    expect(m.title).toBe("Redose window open: Ibuprofen");
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
    expect(m.title).toBe("Redose window open: Ada — Ibuprofen");
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
    expect(m.title).toBe("Redose window open: Ibuprofen");
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
