import { describe, expect, it } from "vitest";
import {
  DATA_TAB_FIRST_PAGE,
  NUTRITION_TAB_FIRST_PAGE,
  RECORDS_TAB_FIRST_PAGE,
  RESULTS_TAB_FIRST_PAGE,
  TRAINING_TAB_FIRST_PAGE,
  tabFirstPageForPath,
} from "@/components/tab-first-pages";

describe("tab-first page registry", () => {
  it("matches a query-tab page only at its exact pathname", () => {
    expect(tabFirstPageForPath("/nutrition")).toBe(NUTRITION_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/nutrition/history")).toBeUndefined();
    expect(tabFirstPageForPath("/training")).toBe(TRAINING_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/training/session")).toBeUndefined();
    expect(tabFirstPageForPath("/data")).toBe(DATA_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/data/anything")).toBeUndefined();
  });

  it("keeps route-tab pages in the shell across their child routes", () => {
    expect(tabFirstPageForPath("/records")).toBe(RECORDS_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/records/history/visits")).toBe(
      RECORDS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results")).toBe(RESULTS_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/results/clinical-results")).toBe(
      RESULTS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results/reports")).toBe(
      RESULTS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results-old")).toBeUndefined();
    expect(tabFirstPageForPath("/records-old")).toBeUndefined();
  });

  // #3236: /nutrition and /results shipped without one, so two of the six hub
  // desktops showed a bare h1 next to four that explained themselves. The
  // subtitle is the only heading copy a tab-first page has — its h1 is redundant
  // with the chrome by design (#1616/#1661) — so an absent one is the whole
  // heading band missing, not a missing flourish.
  it("gives every hub a desktop subtitle", () => {
    for (const config of [
      DATA_TAB_FIRST_PAGE,
      NUTRITION_TAB_FIRST_PAGE,
      RECORDS_TAB_FIRST_PAGE,
      RESULTS_TAB_FIRST_PAGE,
      TRAINING_TAB_FIRST_PAGE,
    ]) {
      expect(config.subtitle, config.pageId).toBeTruthy();
    }
  });
});
