import { describe, expect, it } from "vitest";
import {
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
  });

  it("keeps route-tab pages in the shell across their child routes", () => {
    expect(tabFirstPageForPath("/records")).toBe(RECORDS_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/records/history/visits")).toBe(
      RECORDS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results")).toBe(RESULTS_TAB_FIRST_PAGE);
    expect(tabFirstPageForPath("/results/readings")).toBe(
      RESULTS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results/reports")).toBe(
      RESULTS_TAB_FIRST_PAGE
    );
    expect(tabFirstPageForPath("/results-old")).toBeUndefined();
    expect(tabFirstPageForPath("/records-old")).toBeUndefined();
  });
});
