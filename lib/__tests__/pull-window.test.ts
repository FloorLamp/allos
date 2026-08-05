// PURE TIER — the decisions the one pull-sync runner makes (#2040).
//
// Before the consolidation, three provider modules each carried their own copy of
// these rules and their own copy of the constants behind them. Pinning them here
// means the 429 rule, the page cap and the cursor policies have exactly one
// definition and exactly one test, and the facet that supplies the numbers is
// checked to be TOTAL over the providers that are actually dispatched.

import { describe, it, expect } from "vitest";
import {
  DAY_SECONDS,
  hitPageCap,
  isPullRateLimited,
  pageOutcome,
  pullDayWindow,
  pullSecondsWindow,
  RATE_LIMIT_STATUS,
  shouldAdvanceCursor,
} from "@/lib/integrations/pull-window";
import {
  INTEGRATIONS,
  PULL_INTEGRATIONS,
  getPullIntegration,
  isPullIntegration,
  pullPaging,
} from "@/lib/integrations/registry";

describe("the rate-limit / truncate rule", () => {
  it("treats 429 as truncate for every provider", () => {
    expect(isPullRateLimited(RATE_LIMIT_STATUS)).toBe(true);
    expect(pageOutcome(429)).toBe("truncate");
  });

  it("accepts a provider's own over-quota dialect (Withings' envelope 601)", () => {
    expect(pageOutcome(601)).toBe("fail");
    expect(pageOutcome(601, [601])).toBe("truncate");
  });

  it("fails on everything else — auth, server error, and a network throw's 0", () => {
    for (const status of [0, 400, 401, 403, 404, 500, 502]) {
      expect(pageOutcome(status), `status ${status}`).toBe("fail");
    }
  });

  it("truncates on the last allowed page, not before", () => {
    expect(hitPageCap(0, 25)).toBe(false);
    expect(hitPageCap(23, 25)).toBe(false);
    expect(hitPageCap(24, 25)).toBe(true);
  });
});

describe("the cursor rule", () => {
  it("holds a window-edge cursor when the run was cut short", () => {
    // Oura/Withings: the cursor names the window edge, so advancing after a partial
    // fetch would strand the days past the re-scan margin forever.
    expect(
      shouldAdvanceCursor("hold-on-truncate", true, "2026-08-04", "2026-08-01")
    ).toBe(false);
    expect(
      shouldAdvanceCursor("hold-on-truncate", false, "2026-08-04", "2026-08-01")
    ).toBe(true);
  });

  it("advances a processed-row cursor even when the run was cut short", () => {
    // Strava: the cursor names the newest activity actually imported, so it never
    // points past un-imported data, and holding it would re-pay every detail call.
    expect(shouldAdvanceCursor("advance-to-processed", true, 200, 100)).toBe(
      true
    );
  });

  it("never moves backwards, and never moves without a newer value", () => {
    expect(shouldAdvanceCursor("hold-on-truncate", false, 50, 100)).toBe(false);
    expect(shouldAdvanceCursor("advance-to-processed", false, 100, 100)).toBe(
      false
    );
    expect(shouldAdvanceCursor("hold-on-truncate", false, null, "")).toBe(
      false
    );
    expect(shouldAdvanceCursor("hold-on-truncate", false, undefined, 0)).toBe(
      false
    );
  });

  it("treats an empty first-run day cursor as 'nothing newer learned'", () => {
    expect(shouldAdvanceCursor("hold-on-truncate", false, "", "")).toBe(false);
    expect(
      shouldAdvanceCursor("hold-on-truncate", false, "2026-08-04", "")
    ).toBe(true);
  });
});

describe("the window rule", () => {
  it("re-scans a trailing window before the cursor, ending a day past today", () => {
    expect(pullDayWindow("2026-08-04", "2026-08-05", 3, 30)).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-06",
    });
  });

  it("backfills from today when there is no cursor yet", () => {
    expect(pullDayWindow(null, "2026-08-05", 3, 30)).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-06",
    });
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(pullDayWindow("2026-01-02", "2026-01-03", 3, 30).startDate).toBe(
      "2025-12-30"
    );
  });

  it("mirrors the same rule in epoch seconds, never going negative", () => {
    const now = 1_800_000_000;
    expect(pullSecondsWindow(now - 10 * DAY_SECONDS, now, 3, 30)).toEqual({
      startSec: now - 13 * DAY_SECONDS,
      endSec: now + DAY_SECONDS,
    });
    expect(pullSecondsWindow(0, now, 3, 30).startSec).toBe(
      now - 30 * DAY_SECONDS
    );
    // A cursor near the epoch minus a re-scan margin must not produce a negative
    // instant — Withings would reject it.
    expect(pullSecondsWindow(1, now, 3, 30).startSec).toBe(0);
  });
});

describe("the pull facet is total over dispatched providers", () => {
  it("registers exactly the providers allos pulls on a schedule", () => {
    expect(PULL_INTEGRATIONS.map((i) => i.id).sort()).toEqual([
      "oura",
      "strava",
      "weather",
      "withings",
    ]);
  });

  it("excludes a planned provider even once it declares a facet", () => {
    // Garmin's registry entry is a preview card; there is nothing to run.
    expect(getPullIntegration("garmin")).toBeUndefined();
    expect(
      INTEGRATIONS.filter((i) => i.pull && !isPullIntegration(i)).every(
        (i) => i.status === "planned"
      )
    ).toBe(true);
  });

  it("gives every pull provider at least one surface to revalidate", () => {
    for (const def of PULL_INTEGRATIONS) {
      expect(def.pull.revalidates.length, def.id).toBeGreaterThan(0);
      for (const route of def.pull.revalidates) {
        expect(route.startsWith("/"), `${def.id} → ${route}`).toBe(true);
      }
    }
  });

  it("gives every CREDENTIALED paged provider complete, positive bounds", () => {
    for (const id of ["strava", "oura", "withings"] as const) {
      const paging = pullPaging(id);
      expect(paging.timeoutMs, id).toBeGreaterThan(0);
      expect(paging.maxPages, id).toBeGreaterThan(0);
      expect(paging.rescanDays, id).toBeGreaterThan(0);
      expect(paging.backfillDays, id).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses to invent bounds for a provider that declares none", () => {
    // Weather is keyless with no cursor and no pagination. Reading paging tunables
    // for it is a programming error, not a silent zero that would sync nothing.
    expect(() => pullPaging("weather")).toThrow(/no paging tunables/);
  });
});
