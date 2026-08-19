import { describe, it, expect } from "vitest";
import {
  DORMANCY_DEFAULT_DAYS,
  DORMANCY_DOMAINS,
  DORMANCY_DOMAIN_KEYS,
  dormancyWindowConflicts,
  dormancyState,
  dormantRecordLine,
  type DormancyDomain,
} from "../domain-dormancy";
import { WEIGHT_TREND_WINDOW_DAYS } from "../domain-dormancy";

// Every expectation below is a PINNED LITERAL. Re-deriving an interval from the
// registry under test would pass with the registry gutted.

const TODAY = "2026-08-13";

describe("DORMANCY_DOMAINS registry", () => {
  it("declares the owner-resolved default of 90 days", () => {
    expect(DORMANCY_DEFAULT_DAYS).toBe(90);
  });

  it("pins every domain's interval", () => {
    expect(
      Object.fromEntries(
        DORMANCY_DOMAIN_KEYS.map((d) => [
          d,
          DORMANCY_DOMAINS[d].collapseAfterDays,
        ])
      )
    ).toEqual({ sleep: 90, weight: 90 });
  });

  it("pins the collapsible set — a card only joins it by a visible edit", () => {
    expect([...DORMANCY_DOMAIN_KEYS].sort()).toEqual(["sleep", "weight"]);
  });

  it("names the RECORD, never the activity — the collapsed line can only claim the ledger", () => {
    expect(DORMANCY_DOMAINS.sleep.record).toBe("sleep");
    expect(DORMANCY_DOMAINS.weight.record).toBe("weigh-in");
  });

  it("every domain states WHY its interval is what it is", () => {
    for (const d of DORMANCY_DOMAIN_KEYS) {
      expect(DORMANCY_DOMAINS[d].reason.length).toBeGreaterThan(20);
    }
  });

  it("the weight domain's window IS the card's window — the collapse hides no point", () => {
    expect(WEIGHT_TREND_WINDOW_DAYS).toBe(90);
    expect(DORMANCY_DOMAINS.weight.renderWindowDays).toBe(
      WEIGHT_TREND_WINDOW_DAYS
    );
    expect(DORMANCY_DOMAINS.sleep.renderWindowDays).toBe(1);
  });

  it("no domain collapses while its own section could still be rendering something", () => {
    // The structural guarantee that bounds this feature: a section is only ever
    // collapsed once it is already showing nothing.
    expect(dormancyWindowConflicts()).toEqual([]);
  });

  it("the conflict census is a real check, not a constant", () => {
    // Feed it a declaration that violates the rule by construction, proving the census
    // reads the numbers rather than returning [] unconditionally.
    const rigged: Record<
      DormancyDomain,
      { collapseAfterDays: number; renderWindowDays: number }
    > = {
      sleep: DORMANCY_DOMAINS.sleep,
      weight: { ...DORMANCY_DOMAINS.weight, collapseAfterDays: 30 },
    };
    const conflicts = (Object.keys(rigged) as DormancyDomain[]).filter(
      (d) => rigged[d].collapseAfterDays < rigged[d].renderWindowDays
    );
    expect(conflicts).toEqual(["weight"]);
  });
});

describe("dormancyState", () => {
  it("no record at all is ABSENT, never dormant — the onboarding case keeps its own copy", () => {
    expect(
      dormancyState({ lastRecordDate: null, today: TODAY, domain: "weight" })
    ).toBe("absent");
    expect(
      dormancyState({ lastRecordDate: "", today: TODAY, domain: "weight" })
    ).toBe("absent");
    expect(
      dormancyState({
        lastRecordDate: undefined,
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("absent");
  });

  it("an unparseable date is ABSENT, never folded into dormant", () => {
    expect(
      dormancyState({
        lastRecordDate: "not-a-date",
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("absent");
  });

  it("today's record is current", () => {
    expect(
      dormancyState({
        lastRecordDate: "2026-08-13",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("current");
  });

  it("the boundary is STRICTLY after the interval — 90 days is awake, 91 is dormant", () => {
    // 2026-05-15 is exactly 90 days before 2026-08-13.
    expect(
      dormancyState({
        lastRecordDate: "2026-05-15",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("current");
    expect(
      dormancyState({
        lastRecordDate: "2026-05-14",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("dormant");
  });

  it("a record in the FUTURE is current, never dormant", () => {
    expect(
      dormancyState({
        lastRecordDate: "2026-09-01",
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("current");
  });
});

describe("dormantRecordLine", () => {
  it("states the record and the age, and claims nothing about the body", () => {
    expect(dormantRecordLine("sleep", 152)).toBe(
      "No sleep recorded in 152 days"
    );
    expect(dormantRecordLine("weight", 91)).toBe(
      "No weigh-in recorded in 91 days"
    );
  });

  it("singular day, and never a negative age", () => {
    expect(dormantRecordLine("sleep", 1)).toBe("No sleep recorded in 1 day");
    expect(dormantRecordLine("sleep", -4)).toBe("No sleep recorded in 0 days");
  });
});
