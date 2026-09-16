import { describe, expect, it } from "vitest";
import {
  historyDepthLine,
  nodePin,
} from "../../scripts/orchestration/dispatch-brief.mjs";

// THE SETUP LINES A LANE COPIES WITHOUT CHECKING. Both helpers below answer a
// question about the environment the brief is describing rather than the one it
// is generated in, and a wrong answer is wrong in every lane at once (#5906).

describe("the brief states the history it can actually reach", () => {
  it.each([
    [
      true,
      "abc1234 (2026-07-09) Initial public release",
      "SHALLOW",
      // A BOUNDED deepen: repository policy can refuse `--unshallow` outright,
      // and a prescription that only works where it is allowed is not one.
      "--deepen=200",
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

describe("the brief names which .nvmrc its node major came from", () => {
  // A lane branches from origin/main, so the pin that governs it is the one
  // THAT tree carries. Read from the working tree, a checkout behind main — or
  // one where a lane is editing .nvmrc — pinned every dispatch to a major the
  // merge target does not use, and nothing downstream re-checked it.
  it("prefers origin/main over the checkout it is generated in", () => {
    expect(nodePin("v22.4.1\n", "24\n")).toEqual({
      major: "22",
      at: "origin/main",
    });
  });

  it("falls back to the working tree and says so", () => {
    expect(nodePin(null, "24\n")).toMatchObject({
      major: "24",
      at: expect.stringContaining("working tree"),
    });
  });

  it("answers UNREAD rather than a number when neither can be read", () => {
    // The resolver contract: name the read you could not make. A guessed major
    // is a PATH a lane exports into every shell without checking it.
    expect(nodePin(null, null)).toMatchObject({
      unread: expect.stringContaining("origin/main"),
    });
  });
});
