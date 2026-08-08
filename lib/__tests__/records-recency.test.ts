// PURE TIER — the shared records-recency decision (#2164 + #2176), its episode key,
// the preventive-catalog-derived horizon, and both legs' copy. No DB, no clock.

import { describe, expect, it } from "vitest";
import {
  CHECKUP_RULE_KEYS,
  DEFAULT_CLINICAL_RECENCY_MONTHS,
  RECORDS_RECENCY_PREFIX,
  RECORDS_RECENCY_SOURCES,
  archiveRecencySource,
  archiveRefreshCopy,
  clinicalRecencyCopy,
  clinicalRecencyHorizonDays,
  clinicalRecencyHorizonMonths,
  joinStreamLabels,
  recencyIntervalPhrase,
  recordsRecencyDedupeKey,
  recordsRecencyVerdict,
} from "@/lib/records-recency";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import { RULE_FINDING_REGISTRY } from "@/lib/rule-finding-prefixes";

const TODAY = "2026-08-08";

function signals(
  over: Partial<Parameters<typeof recordsRecencyVerdict>[0]> = {}
) {
  return {
    frontier: "2026-06-01",
    today: TODAY,
    horizonDays: 30,
    ownedElsewhere: false,
    ...over,
  };
}

describe("recordsRecencyVerdict — the one decision both legs share", () => {
  it("is due once the frontier is STRICTLY past the horizon", () => {
    // 2026-07-09 is exactly 30 days before today: still current, per the house
    // freshness boundary (stale strictly AFTER the interval).
    expect(recordsRecencyVerdict(signals({ frontier: "2026-07-09" }))).toEqual({
      due: false,
      skip: "current",
    });
    expect(recordsRecencyVerdict(signals({ frontier: "2026-07-08" }))).toEqual({
      due: true,
      frontier: "2026-07-08",
      daysBehind: 31,
    });
  });

  it("is silent with no frontier at all — nothing has ever arrived to age", () => {
    expect(recordsRecencyVerdict(signals({ frontier: null }))).toEqual({
      due: false,
      skip: "no-frontier",
    });
  });

  it("yields to the mechanism that already owns the ask, however stale the data", () => {
    expect(
      recordsRecencyVerdict(
        signals({ frontier: "2019-01-01", ownedElsewhere: true })
      )
    ).toEqual({ due: false, skip: "owned-elsewhere" });
  });

  it("checks ownership BEFORE the frontier, so an owned profile never mints a key", () => {
    // Order matters: both guards would return `due: false`, but only this order keeps
    // "one ask per problem" true for a profile with no data at all AND a portal.
    expect(
      recordsRecencyVerdict(signals({ frontier: null, ownedElsewhere: true }))
        .due
    ).toBe(false);
    expect(
      recordsRecencyVerdict(signals({ frontier: null, ownedElsewhere: true }))
    ).toEqual({ due: false, skip: "owned-elsewhere" });
  });

  it("treats an unparseable frontier as no frontier rather than as infinitely stale", () => {
    expect(recordsRecencyVerdict(signals({ frontier: "not-a-date" }))).toEqual({
      due: false,
      skip: "no-frontier",
    });
  });

  it("reads the DATA date only — a future-dated frontier is not behind", () => {
    expect(recordsRecencyVerdict(signals({ frontier: "2026-09-01" }))).toEqual({
      due: false,
      skip: "current",
    });
  });
});

describe("the episode key", () => {
  it("is registered under the shared prefix", () => {
    const key = recordsRecencyDedupeKey("clinical-records", "2025-05-12");
    expect(key.startsWith(RECORDS_RECENCY_PREFIX)).toBe(true);
    expect(
      RULE_FINDING_REGISTRY.some((e) => e.prefix === RECORDS_RECENCY_PREFIX)
    ).toBe(true);
  });

  it("is COACHING tier — no send, ever", () => {
    const entry = RULE_FINDING_REGISTRY.find(
      (e) => e.prefix === RECORDS_RECENCY_PREFIX
    );
    expect(entry?.tier).toBe("coaching");
  });

  it("is stable while the frontier is unchanged — a backfill of older rows does not move it", () => {
    // A backfill leaves MAX(date) alone, so the key a dismissal was filed under is the
    // key the ask still mints.
    expect(recordsRecencyDedupeKey("clinical-records", "2025-05-12")).toBe(
      recordsRecencyDedupeKey("clinical-records", "2025-05-12")
    );
  });

  it("changes when the frontier advances — a new staleness episode is a new ask", () => {
    expect(recordsRecencyDedupeKey("clinical-records", "2025-05-12")).not.toBe(
      recordsRecencyDedupeKey("clinical-records", "2026-07-30")
    );
  });

  it("separates the two legs, and one archive provider from another", () => {
    expect(archiveRecencySource("fitbit-takeout")).toBe(
      "archive:fitbit-takeout"
    );
    expect(
      recordsRecencyDedupeKey(
        archiveRecencySource("fitbit-takeout"),
        "2026-07-26"
      )
    ).not.toBe(recordsRecencyDedupeKey("clinical-records", "2026-07-26"));
    expect(RECORDS_RECENCY_SOURCES).toContain("archive:fitbit-takeout");
    expect(RECORDS_RECENCY_SOURCES).toContain("clinical-records");
  });
});

describe("clinicalRecencyHorizon — read from the preventive catalog, not written here", () => {
  it("uses the adult check-up rule's own interval + grace for an adult", () => {
    const rule = preventiveRuleByKey("adult_physical");
    if (!rule || rule.schedule.type !== "recurring")
      throw new Error("adult_physical must stay a recurring rule");
    const expected = rule.schedule.intervalMonths + rule.graceMonths;
    expect(clinicalRecencyHorizonMonths(40 * 12)).toBe(expected);
  });

  it("uses the WELL-CHILD annual rule for a school-age profile", () => {
    const rule = preventiveRuleByKey("wellchild_annual");
    if (!rule || rule.schedule.type !== "recurring")
      throw new Error("wellchild_annual must stay a recurring rule");
    expect(clinicalRecencyHorizonMonths(8 * 12)).toBe(
      rule.schedule.intervalMonths + rule.graceMonths
    );
  });

  it("hands over between the two rules at the well-child rule's own end age", () => {
    const rule = preventiveRuleByKey("wellchild_annual");
    if (!rule || rule.schedule.type !== "recurring") throw new Error("shape");
    const end = rule.schedule.endMonths!;
    // Just inside the pediatric band and just past it both resolve — the point is that
    // NEITHER falls through to the default, i.e. the bands actually tile.
    expect(clinicalRecencyHorizonMonths(end - 1)).toBeGreaterThan(0);
    expect(clinicalRecencyHorizonMonths(end)).toBeGreaterThan(0);
  });

  it("falls back to the declared default for an unknown age and for an infant", () => {
    expect(clinicalRecencyHorizonMonths(null)).toBe(
      DEFAULT_CLINICAL_RECENCY_MONTHS
    );
    expect(clinicalRecencyHorizonMonths(6)).toBe(
      DEFAULT_CLINICAL_RECENCY_MONTHS
    );
  });

  it("names only routine CHECK-UP rules — a dental or vision cadence must not set it", () => {
    expect([...CHECKUP_RULE_KEYS].sort()).toEqual([
      "adult_physical",
      "wellchild_annual",
    ]);
    for (const key of CHECKUP_RULE_KEYS) {
      expect(preventiveRuleByKey(key)).toBeDefined();
    }
  });

  it("converts to a whole number of days around the annual rhythm the issue asked for", () => {
    const days = clinicalRecencyHorizonDays(40 * 12);
    expect(Number.isInteger(days)).toBe(true);
    // ~12 months plus the catalog's own grace — comfortably past a year, comfortably
    // short of two.
    expect(days).toBeGreaterThan(365);
    expect(days).toBeLessThan(2 * 365);
  });
});

describe("copy — states the data, names the action", () => {
  it("archives: names the streams, the frontier and the drift", () => {
    const copy = archiveRefreshCopy({
      providerName: "Fitbit (Google Takeout)",
      streamLabels: ["weight", "body fat", "sleep score"],
      frontier: "2026-07-26",
      daysBehind: 41,
    });
    expect(copy.title).toBe("Import a fresh Fitbit (Google Takeout) export");
    expect(copy.detail).toContain("weight, body fat and sleep score");
    expect(copy.detail).toContain("2026-07-26");
    expect(copy.detail).toContain("41 days behind");
    expect(copy.because).toBe(
      "weight, body fat and sleep score are 41 days behind"
    );
    // Never about the person.
    expect(copy.detail.toLowerCase()).not.toContain("you haven't");
    expect(copy.detail.toLowerCase()).not.toContain("you have not");
  });

  it("archives: agrees with itself on a single stream", () => {
    const copy = archiveRefreshCopy({
      providerName: "Fitbit (Google Takeout)",
      streamLabels: ["weight"],
      frontier: "2026-07-26",
      daysBehind: 31,
    });
    expect(copy.because).toBe("weight is 31 days behind");
  });

  it("labs: names the frontier and BOTH fixes", () => {
    const copy = clinicalRecencyCopy({
      frontier: "2025-05-12",
      daysBehind: 453,
    });
    expect(copy.detail).toContain("2025-05-12");
    expect(copy.detail).toContain("Upload recent results");
    expect(copy.detail).toContain("connect a patient portal");
    expect(copy.because).toBe("the newest lab result is from 2025-05-12");
    expect(copy.detail.toLowerCase()).not.toContain("you haven't");
  });

  it("phrases an interval coarsely and honestly", () => {
    expect(recencyIntervalPhrase(1)).toBe("1 day");
    expect(recencyIntervalPhrase(31)).toBe("31 days");
    expect(recencyIntervalPhrase(63)).toBe("9 weeks");
    expect(recencyIntervalPhrase(453)).toBe("15 months");
  });

  it("joins stream labels without an Oxford comma", () => {
    expect(joinStreamLabels([])).toBe("");
    expect(joinStreamLabels(["weight"])).toBe("weight");
    expect(joinStreamLabels(["weight", "body fat"])).toBe(
      "weight and body fat"
    );
    expect(joinStreamLabels(["a", "b", "c"])).toBe("a, b and c");
  });
});
