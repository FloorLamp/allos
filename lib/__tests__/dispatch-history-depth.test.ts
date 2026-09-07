import { describe, expect, it } from "vitest";
import { historyDepthLine } from "../../scripts/orchestration/dispatch-brief.mjs";

describe("the brief states the history it can actually reach", () => {
  it.each([
    [
      true,
      "abc1234 (2026-07-09) Initial public release",
      "SHALLOW",
      "deepen, then check",
    ],
    [
      false,
      "abc1234 (2026-07-09) Initial public release",
      "FULL history",
      "IS checkable here",
    ],
  ])("shallow=%s says %s", (shallow, first, verdict, consequence) => {
    const line = historyDepthLine(shallow, first);
    expect(line).toContain(verdict);
    expect(line).toContain(consequence);
    expect(line).toContain("abc1234 (2026-07-09)");
  });

  // The root read can fail — a bare repo, a git that will not answer. Saying
  // "could not be read" is the honest third state; inventing a boundary is not.
  it.each([true, false])(
    "names the unreadable root when shallow=%s",
    (shallow) => {
      expect(historyDepthLine(shallow, null)).toContain(
        "oldest reachable commit could not be read"
      );
    }
  );
});
