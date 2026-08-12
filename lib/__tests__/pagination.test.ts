import { describe, it, expect } from "vitest";
import {
  HISTORY_PAGE_SIZE,
  clampPage,
  pageCount,
  pageOffset,
} from "@/lib/pagination";

// The shared paging arithmetic (#2530/#2445). It was the audit viewer's until a
// history table, a dose ledger and the changelog needed the same answers; these
// cases came with it.
describe("pagination math", () => {
  it("clampPage coerces to a 1-based integer", () => {
    expect(clampPage(1)).toBe(1);
    expect(clampPage(3)).toBe(3);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-5)).toBe(1);
    expect(clampPage(2.7)).toBe(2);
    expect(clampPage(NaN)).toBe(1);
  });

  it("pageOffset is (page-1)*pageSize on a clamped page", () => {
    expect(pageOffset(1, 50)).toBe(0);
    expect(pageOffset(2, 50)).toBe(50);
    expect(pageOffset(3, 20)).toBe(40);
    expect(pageOffset(0, 50)).toBe(0); // clamped to page 1
  });

  it("pageCount is a ceil, at least 1", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(101, 50)).toBe(3);
  });

  it("the last page's offset never exceeds the total", () => {
    // The pager and the reader agree: clicking through to the final page always
    // lands on a slice that has rows in it.
    for (const total of [1, 9, 10, 11, 99, 100]) {
      const last = pageCount(total, HISTORY_PAGE_SIZE);
      expect(pageOffset(last, HISTORY_PAGE_SIZE)).toBeLessThan(total);
    }
  });

  it("record-history surfaces share ONE page size", () => {
    expect(HISTORY_PAGE_SIZE).toBe(10);
  });
});
