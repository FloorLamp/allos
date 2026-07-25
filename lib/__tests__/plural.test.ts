import { describe, expect, it } from "vitest";
import { plural, countLabel } from "@/lib/plural";
import { providersEmptyMessage } from "@/lib/providers";

describe("plural", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "error", "errors")).toBe("error");
  });

  it("uses the plural for zero and for many", () => {
    // Zero is plural in English ("0 errors"), which is the case the naive
    // `n > 1` check gets wrong.
    expect(plural(0, "error", "errors")).toBe("errors");
    expect(plural(2, "error", "errors")).toBe("errors");
    expect(plural(17, "error", "errors")).toBe("errors");
  });

  it("carries an irregular plural when the caller supplies one", () => {
    expect(plural(1, "person", "people")).toBe("person");
    expect(plural(3, "person", "people")).toBe("people");
  });
});

describe("countLabel", () => {
  it("renders the count with an agreeing noun", () => {
    // The #1447 defect: Settings → Errors rendered a bare `{n} errors`, so a
    // single error read "1 errors".
    expect(countLabel(1, "error")).toBe("1 error");
    expect(countLabel(0, "error")).toBe("0 errors");
    expect(countLabel(2, "error")).toBe("2 errors");
  });

  it("defaults the plural to the regular -s form", () => {
    expect(countLabel(4, "profile")).toBe("4 profiles");
  });

  it("accepts an explicit irregular plural", () => {
    expect(countLabel(1, "entry", "entries")).toBe("1 entry");
    expect(countLabel(5, "entry", "entries")).toBe("5 entries");
  });
});

describe("providersEmptyMessage", () => {
  it("says 'no providers yet' when no query is active", () => {
    // The #1447 defect: an untouched, empty search box rendered the
    // filter-flavoured "No providers match.", telling a first-time user their
    // search had failed when they had not searched at all.
    const msg = providersEmptyMessage(false);
    expect(msg).toContain("No providers yet");
    expect(msg).not.toContain("match");
    // The true empty state still explains how providers get there.
    expect(msg).toContain("import");
  });

  it("uses the match wording only when a query is active", () => {
    const msg = providersEmptyMessage(true);
    expect(msg).toContain("match");
    expect(msg).not.toContain("No providers yet");
  });
});
