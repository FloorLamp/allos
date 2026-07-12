import { describe, expect, it } from "vitest";
import {
  formatLastUsed,
  formatSessionCount,
  formatUsageSummary,
} from "../usage-format";

describe("formatLastUsed", () => {
  const today = "2026-07-12";
  it("phrases today / yesterday / N days ago", () => {
    expect(formatLastUsed("2026-07-12", today)).toBe("today");
    expect(formatLastUsed("2026-07-11", today)).toBe("yesterday");
    expect(formatLastUsed("2026-07-09", today)).toBe("3 days ago");
  });
  it("treats null / future / unparseable as never", () => {
    expect(formatLastUsed(null, today)).toBe("never");
    expect(formatLastUsed(undefined, today)).toBe("never");
    expect(formatLastUsed("2026-07-13", today)).toBe("never");
    expect(formatLastUsed("not-a-date", today)).toBe("never");
  });
});

describe("formatSessionCount", () => {
  it("singular / plural / none", () => {
    expect(formatSessionCount(0)).toBe("no sessions yet");
    expect(formatSessionCount(1)).toBe("1 session");
    expect(formatSessionCount(23)).toBe("23 sessions");
  });
});

describe("formatUsageSummary", () => {
  const today = "2026-07-12";
  it("combines count and recency", () => {
    expect(formatUsageSummary(23, "2026-07-09", today)).toBe(
      "23 sessions · last 3 days ago"
    );
    expect(formatUsageSummary(1, "2026-07-12", today)).toBe(
      "1 session · last today"
    );
  });
  it("shows only the empty phrase when there are no sessions", () => {
    expect(formatUsageSummary(0, null, today)).toBe("no sessions yet");
  });
});
