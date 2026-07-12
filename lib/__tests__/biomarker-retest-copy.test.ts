import { describe, expect, it } from "vitest";
import {
  biomarkerRetestTitle,
  biomarkerRetestDetail,
  isFlaggedForRetest,
} from "@/lib/biomarker-retest-copy";

// Copy policy for the Upcoming biomarker RETEST item (issues #513 / #514).
describe("biomarkerRetestTitle", () => {
  it("carries the action verb so the row reads as an action, not a flag alert", () => {
    expect(biomarkerRetestTitle("HDL Cholesterol")).toBe(
      "Retest HDL Cholesterol"
    );
  });
});

describe("isFlaggedForRetest", () => {
  it("treats out-of-range and non-optimal as flagged; normal/null quiet", () => {
    expect(isFlaggedForRetest("low")).toBe(true);
    expect(isFlaggedForRetest("high")).toBe(true);
    expect(isFlaggedForRetest("abnormal")).toBe(true);
    expect(isFlaggedForRetest("non-optimal-low")).toBe(true);
    expect(isFlaggedForRetest("non-optimal")).toBe(true);
    expect(isFlaggedForRetest("normal")).toBe(false);
    expect(isFlaggedForRetest(null)).toBe(false);
    expect(isFlaggedForRetest(undefined)).toBe(false);
  });
});

describe("biomarkerRetestDetail", () => {
  const base = {
    effectiveDate: "2024-01-15",
    agoMonths: 14,
    intervalMonths: 12,
  };

  it("states last-tested + cadence for an unflagged (or normal) reading", () => {
    expect(biomarkerRetestDetail(base)).toBe(
      "Last tested 2024-01-15 (14mo ago) · retest every 12mo"
    );
    expect(biomarkerRetestDetail({ ...base, flag: "normal" })).toBe(
      "Last tested 2024-01-15 (14mo ago) · retest every 12mo"
    );
  });

  it("leads with the status when the stale reading was flagged", () => {
    // The user-reported case: a below-optimal HDL should say so, not present a
    // bare retest line that reads as "what do I do with this?".
    expect(biomarkerRetestDetail({ ...base, flag: "non-optimal-low" })).toBe(
      "Below optimal at last test · Last tested 2024-01-15 (14mo ago) · retest every 12mo"
    );
    expect(biomarkerRetestDetail({ ...base, flag: "high" })).toBe(
      "High at last test · Last tested 2024-01-15 (14mo ago) · retest every 12mo"
    );
  });
});
