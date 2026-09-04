import { describe, expect, it, vi } from "vitest";
import {
  RETIRED_PAGE_VISITS_KEY,
  TRACKED_PAGES,
  clearRetiredPageVisits,
  trackedPageFor,
} from "@/lib/recent-pages";

// The route → page-name registry (issue #1416, section E3).
//
// This file used to test three more exports — the visit tally, the frequency
// ranking and the stored-JSON parser. #4102 retired Frequent and deleted them, so
// what is left is the half that outlived it: the dashboard's only way to ask what
// a route is CALLED (`DashboardPlacementCanvas` throws on a route it cannot name).

describe("trackedPageFor", () => {
  // A section anchor is a position on a page, not a different page (#1644), and
  // the Trends hub's own deep links carry one — so the fragment and the query are
  // cut before the match, or the hub has no name.
  it.each([
    ["a top-level route, exactly", "/history", "/history", "History"],
    ["the dashboard, only exactly", "/", "/", "Dashboard"],
    [
      "a child route, by its section",
      "/records/care/providers",
      "/records",
      "Health record",
    ],
    // /medical/episodes/17 belongs to Illness episodes, not to any shorter
    // /medical* entry a future change might add: longest href wins.
    [
      "the LONGEST matching section",
      "/medical/episodes/17",
      "/medical/episodes",
      "Illness episodes",
    ],
    [
      "a query string, ignored",
      "/nutrition?tab=supplements",
      "/nutrition",
      "Nutrition",
    ],
    ["a trailing slash, ignored", "/history/", "/history", "History"],
    // A source's setup page: the row that asks for a portal run or a fresh export
    // goes here, and it must get a door like every other Ahead row.
    [
      "a source setup page",
      "/integrations/patient-portals",
      "/integrations",
      "Integrations",
    ],
    ["a section anchor, ignored", "/trends#body", "/trends", "Trends"],
    [
      "a query AND an anchor together",
      "/trends?range=all#insights",
      "/trends",
      "Trends",
    ],
  ])("resolves %s", (_case, path, href, label) => {
    expect(trackedPageFor(path)).toEqual({ href, label });
  });

  it("never lets the dashboard swallow every path by prefix", () => {
    expect(trackedPageFor("/somewhere-untracked")).toBeNull();
  });
});

describe("the tracked-page allowlist", () => {
  it("has unique hrefs and a label for each", () => {
    const hrefs = TRACKED_PAGES.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const page of TRACKED_PAGES) {
      expect(page.label.trim().length).toBeGreaterThan(0);
    }
    expect(hrefs).toContain("/wellness");
  });
});

describe("the retired visit tally", () => {
  it("can only be removed", () => {
    const removeItem = vi.fn();
    clearRetiredPageVisits({ removeItem });
    expect(removeItem).toHaveBeenCalledOnce();
    expect(removeItem).toHaveBeenCalledWith(RETIRED_PAGE_VISITS_KEY);
  });
});
