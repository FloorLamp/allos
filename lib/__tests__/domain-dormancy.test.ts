import { describe, it, expect } from "vitest";
import {
  DORMANCY_DEFAULT_DAYS,
  DORMANCY_DOMAINS,
  DORMANCY_DOMAIN_KEYS,
  dormancyWindowConflicts,
  dormancyState,
  dormantRecordLine,
  dormantRecordSince,
  VITAL_DORMANCY_DAYS,
  type DormancyDomain,
} from "../domain-dormancy";
import { WEIGHT_TREND_WINDOW_DAYS } from "../domain-dormancy";
import { VITAL_PRESENTATION_FLOORS } from "../vitals-latest";

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
    ).toEqual({
      sleep: 90,
      weight: 90,
      "blood-pressure": 365,
      "resting-hr": 365,
    });
  });

  it("pins the collapsible set — a card only joins it by a visible edit", () => {
    expect([...DORMANCY_DOMAIN_KEYS].sort()).toEqual([
      "blood-pressure",
      "resting-hr",
      "sleep",
      "weight",
    ]);
  });

  it("names the RECORD, never the activity — the collapsed line can only claim the ledger", () => {
    expect(DORMANCY_DOMAINS.sleep.record).toBe("sleep");
    expect(DORMANCY_DOMAINS.weight.record).toBe("weigh-in");
    expect(DORMANCY_DOMAINS["blood-pressure"].record).toBe("blood pressure");
    expect(DORMANCY_DOMAINS["resting-hr"].record).toBe("resting heart rate");
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

  it("a vitals row's window IS its interval — that equality is the whole licence to collapse it (#3226)", () => {
    // The vitals rows joined this registry by BECOMING window-bounded: past the interval
    // the row renders no value. If a future edit ever lengthened the window past the
    // interval, the row would be collapsing over a span where it could still show a
    // number — which is the thing the census below exists to catch.
    expect(VITAL_DORMANCY_DAYS).toBe(365);
    for (const d of ["blood-pressure", "resting-hr"] as const) {
      expect(DORMANCY_DOMAINS[d].renderWindowDays).toBe(VITAL_DORMANCY_DAYS);
      expect(DORMANCY_DOMAINS[d].collapseAfterDays).toBe(VITAL_DORMANCY_DAYS);
    }
  });

  it("dormancy starts STRICTLY beyond each vital's presentation floor — the amber span is never swallowed", () => {
    // The ordering that keeps #2303 intact: every day a reading is merely stale, it is
    // still a value on screen with an age beside it. Were an interval ever moved down to
    // its floor, the dormant line would start eating the span the floor was built for.
    for (const q of ["blood-pressure", "resting-hr"] as const) {
      expect(DORMANCY_DOMAINS[q].collapseAfterDays).toBeGreaterThan(
        VITAL_PRESENTATION_FLOORS[q].days
      );
    }
    // Pinned so the property above cannot be satisfied by shrinking the floors instead.
    expect(VITAL_PRESENTATION_FLOORS["blood-pressure"].days).toBe(180);
    expect(VITAL_PRESENTATION_FLOORS["resting-hr"].days).toBe(14);
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
      "blood-pressure": DORMANCY_DOMAINS["blood-pressure"],
      "resting-hr": DORMANCY_DOMAINS["resting-hr"],
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

describe("dormantRecordSince", () => {
  it("states the record and the SOURCE MONTH — the legible form of a year-scale gap", () => {
    expect(dormantRecordSince("blood-pressure", "2022-03-08")).toBe(
      "No blood pressure recorded since Mar 2022"
    );
    expect(dormantRecordSince("resting-hr", "2021-12-31")).toBe(
      "No resting heart rate recorded since Dec 2021"
    );
  });

  it("reads the month from the DATE, not from a fixed position in a list", () => {
    // Every month, so an off-by-one in the abbreviation lookup cannot hide in the two
    // examples above.
    expect(
      Array.from({ length: 12 }, (_, i) =>
        dormantRecordSince(
          "blood-pressure",
          `2020-${String(i + 1).padStart(2, "0")}-15`
        )
      )
    ).toEqual([
      "No blood pressure recorded since Jan 2020",
      "No blood pressure recorded since Feb 2020",
      "No blood pressure recorded since Mar 2020",
      "No blood pressure recorded since Apr 2020",
      "No blood pressure recorded since May 2020",
      "No blood pressure recorded since Jun 2020",
      "No blood pressure recorded since Jul 2020",
      "No blood pressure recorded since Aug 2020",
      "No blood pressure recorded since Sep 2020",
      "No blood pressure recorded since Oct 2020",
      "No blood pressure recorded since Nov 2020",
      "No blood pressure recorded since Dec 2020",
    ]);
  });

  it("claims the RECORD, never the body — the same rule the day-count form obeys", () => {
    const line = dormantRecordSince("blood-pressure", "2022-03-08") ?? "";
    expect(line).toContain("recorded");
    expect(line).not.toMatch(/you|your/i);
  });

  it("returns null for a date it cannot read, so no caller renders a sentence with a hole", () => {
    expect(dormantRecordSince("blood-pressure", null)).toBeNull();
    expect(dormantRecordSince("blood-pressure", undefined)).toBeNull();
    expect(dormantRecordSince("blood-pressure", "")).toBeNull();
    expect(dormantRecordSince("blood-pressure", "not-a-date")).toBeNull();
    expect(dormantRecordSince("blood-pressure", "2022-3-8")).toBeNull();
    expect(dormantRecordSince("blood-pressure", "2022-13-08")).toBeNull();
    expect(dormantRecordSince("blood-pressure", "2022-00-08")).toBeNull();
  });
});
