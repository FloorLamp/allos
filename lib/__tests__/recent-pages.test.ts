import { describe, expect, it } from "vitest";
import {
  FREQUENT_MIN_VISITS,
  MAX_TRACKED,
  TRACKED_PAGES,
  frequentPages,
  parsePageVisits,
  recordPageVisit,
  trackedPageFor,
  type PageVisits,
} from "@/lib/recent-pages";

// The drawer's most-visited shortcuts (issue #1416, section E3).

describe("trackedPageFor", () => {
  it("matches a top-level route exactly", () => {
    expect(trackedPageFor("/timeline")?.label).toBe("Timeline");
    expect(trackedPageFor("/")?.label).toBe("Dashboard");
  });

  it("attributes a child route to its section", () => {
    expect(trackedPageFor("/records/care/providers")?.href).toBe("/records");
    expect(trackedPageFor("/trends/anything")?.href).toBe("/trends");
  });

  it("prefers the LONGEST matching section", () => {
    // /medical/episodes/17 belongs to Illness episodes, not to any shorter
    // /medical* entry a future change might add.
    expect(trackedPageFor("/medical/episodes/17")?.href).toBe(
      "/medical/episodes"
    );
  });

  it("never lets the dashboard swallow every path by prefix", () => {
    expect(trackedPageFor("/somewhere-untracked")).toBeNull();
  });

  it("ignores a query string and a trailing slash", () => {
    expect(trackedPageFor("/nutrition?tab=supplements")?.href).toBe(
      "/nutrition"
    );
    expect(trackedPageFor("/timeline/")?.href).toBe("/timeline");
  });
});

describe("recordPageVisit", () => {
  it("counts a tracked visit without mutating the input", () => {
    const before: PageVisits = {};
    const after = recordPageVisit(before, "/timeline", 1000);
    expect(before).toEqual({});
    expect(after["/timeline"]).toEqual({ n: 1, t: 1000 });
    expect(recordPageVisit(after, "/timeline", 2000)["/timeline"]).toEqual({
      n: 2,
      t: 2000,
    });
  });

  it("returns the SAME object for an untracked path (no write, no churn)", () => {
    const visits: PageVisits = { "/timeline": { n: 2, t: 1 } };
    expect(recordPageVisit(visits, "/untracked-thing", 9)).toBe(visits);
  });

  it("prunes the least-recently-visited entries past the cap", () => {
    let visits: PageVisits = {};
    for (let i = 0; i < MAX_TRACKED + 5; i++) {
      visits[`/stale-${i}`] = { n: 1, t: i };
    }
    visits = recordPageVisit(visits, "/timeline", 10_000);
    expect(Object.keys(visits).length).toBe(MAX_TRACKED);
    expect(visits["/timeline"]).toBeDefined();
    // The oldest ones went first.
    expect(visits["/stale-0"]).toBeUndefined();
  });
});

describe("frequentPages", () => {
  const visits: PageVisits = {
    "/timeline": { n: 9, t: 5 },
    "/trends": { n: 9, t: 9 },
    "/nutrition": { n: 4, t: 1 },
    "/settings": { n: FREQUENT_MIN_VISITS - 1, t: 100 },
  };

  it("ranks by visit count, breaking ties by recency", () => {
    expect(frequentPages(visits).map((p) => p.href)).toEqual([
      "/trends",
      "/timeline",
      "/nutrition",
    ]);
  });

  it("holds back a page that hasn't become a habit yet", () => {
    expect(frequentPages(visits).map((p) => p.href)).not.toContain("/settings");
  });

  it("excludes the page you're standing on — including from a child route", () => {
    expect(
      frequentPages(visits, { currentPath: "/trends?tab=body" }).map(
        (p) => p.href
      )
    ).toEqual(["/timeline", "/nutrition"]);
  });

  it("renders nothing for a fresh login", () => {
    expect(frequentPages({})).toEqual([]);
  });

  it("respects the limit", () => {
    expect(frequentPages(visits, { limit: 1 }).map((p) => p.href)).toEqual([
      "/trends",
    ]);
  });
});

describe("parsePageVisits", () => {
  it("degrades to an empty tally rather than throwing", () => {
    expect(parsePageVisits(null)).toEqual({});
    expect(parsePageVisits("not json")).toEqual({});
    expect(parsePageVisits("[1,2,3]")).toEqual({});
    expect(parsePageVisits("null")).toEqual({});
  });

  it("drops malformed entries and keeps the good ones", () => {
    const parsed = parsePageVisits(
      JSON.stringify({
        "/timeline": { n: 3, t: 12 },
        "/trends": { n: "many", t: 4 },
        "/nutrition": { n: 0, t: 4 },
        "/sleep": { n: 2 },
        "/data": "nope",
      })
    );
    expect(parsed).toEqual({
      "/timeline": { n: 3, t: 12 },
      "/sleep": { n: 2, t: 0 },
    });
  });
});

describe("the tracked-page allowlist", () => {
  it("has unique hrefs and a label for each", () => {
    const hrefs = TRACKED_PAGES.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const page of TRACKED_PAGES) {
      expect(page.label.trim().length).toBeGreaterThan(0);
    }
  });
});
