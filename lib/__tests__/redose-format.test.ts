import { describe, it, expect } from "vitest";
import {
  redoseNoticeMessage,
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
    expect(m.title).toBe("Redose window open — Ibuprofen");
    expect(m.body).toBe(
      "6h since Ibuprofen (4:02pm) — your minimum interval has passed · 2 of 4 today."
    );
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
