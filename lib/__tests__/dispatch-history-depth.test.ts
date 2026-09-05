import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyDepthLine } from "../../scripts/orchestration/dispatch-brief.mjs";

// A BRIEF MAY NOT ASSERT A FACT ABOUT THE CONTAINER IT IS GENERATED IN.
//
// The brief carried "THIS CLONE IS SHALLOW … `git log --reverse` starts on
// 2026-08-29" as literal text, inside the rule that says a number in prose must
// come from a command you ran. The clone was unshallowed and the sentence went
// false in the direction that STOPS work: on 2026-09-05 a lane needed
// `git show <sha>^:<file>` to verify a two-merge chain and the brief told it
// that was impossible here. Discovered, not asserted — and no date baked into
// either branch, because a date is the part that goes stale silently.

const source = fs.readFileSync(
  path.join(process.cwd(), "scripts/orchestration/dispatch-brief.mjs"),
  "utf8"
);

describe("the brief states the history it can actually reach", () => {
  it.each([
    [
      true,
      "abc1234 (2026-07-09) Initial public release",
      "SHALLOW",
      "UNREACHABLE",
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

  // SCOPED TO THE TEMPLATE, not to the file. The comment above the helper
  // QUOTES the sentence that was removed, in order to argue against it, and a
  // whole-file absence sweep would read that quotation as the defect — the
  // failure direction that sends the next reader to "fix" correct code.
  it("computes the claim rather than baking one, and bakes no date", () => {
    const template = source.slice(source.indexOf("const brief = `"));
    expect(template).toContain("${historyDepth()}");
    // The converse of the absences: a sweep for a removed sentence passes just
    // as happily on a template that lost the whole rule.
    expect(template).toContain("CHECK WHAT YOURS CAN REACH BEFORE YOU CLAIM");
    expect(template).not.toContain(
      "THIS CLONE IS SHALLOW, history begins two days"
    );
    expect(template).not.toContain("starts on 2026-08-29");
  });
});
