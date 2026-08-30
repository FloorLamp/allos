import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  E2E_LANE_CAP,
  MACHINE_CAP_WARN,
  e2eLaneRefusal,
} from "../../scripts/orchestration/dispatch-brief.mjs";

// The E2E lane cap, moved from an inline count in `new` to a predicate — the
// same lesson the port-collision rule paid for (#3608): a rule that lives at
// one call site is a rule the next call site skips. Two agents in the E2E
// lane is a load limit that holds on every host (dispatch.md §Dispatch); the
// third dispatch is refused, not warned, because a brief already pasted into
// an agent is not going to be re-read.

const E2E = (branch: string) => ({ branch, e2e: true });
const PLAIN = (branch: string) => ({ branch, e2e: false });

describe("e2eLaneRefusal", () => {
  it("refuses the third E2E lane and names the two holding it", () => {
    const refusal = e2eLaneRefusal(
      [E2E("a"), E2E("b"), PLAIN("c")],
      "new-lane"
    );
    expect(refusal).toContain("a, b");
    expect(refusal).toContain("dispatch.md");
  });

  it("admits the second lane — the cap is two, not one", () => {
    expect(e2eLaneRefusal([E2E("a"), PLAIN("b")], "new-lane")).toBeNull();
  });

  it("does not count non-E2E dispatches against the lane", () => {
    expect(
      e2eLaneRefusal([PLAIN("a"), PLAIN("b"), PLAIN("c")], "new-lane")
    ).toBeNull();
  });

  it("never counts a dispatch against ITSELF — resuming lane A over a full lane {A,B} is legal", () => {
    expect(e2eLaneRefusal([E2E("a"), E2E("b")], "a")).toBeNull();
  });

  it("pins the caps to the runbook's numbers", () => {
    // dispatch.md §Dispatch: "Cap E2E work at two agents" (every host);
    // "five on the 4-core container" for the machine warning.
    expect(E2E_LANE_CAP).toBe(2);
    expect(MACHINE_CAP_WARN).toBe(5);
  });
});

describe("the predicate is applied everywhere a lane can come alive", () => {
  // The #3608 failure shape, guarded directly: the rule existing is not the
  // rule being asked. All three creation paths — `new`, `resume`, `adopt` —
  // consult the predicate; only `brief` (a reprint of a lane already alive)
  // has nothing to ask.
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/orchestration/dispatch-brief.mjs"),
    "utf8"
  );

  it("new, resume and adopt each consult e2eLaneRefusal", () => {
    expect(source).toMatch(
      /opts\.e2e && e2eLaneRefusal\(active, opts\.branch\)/
    );
    expect(source).toMatch(
      /prior\.e2e && e2eLaneRefusal\(active, prior\.branch\)/
    );
    expect(source).toMatch(/opts\.e2e && e2eLaneRefusal\(active, branch\)/);
  });

  it("no inline e2e count survives outside the predicate", () => {
    expect(source).not.toMatch(/filter\(\(d\) => d\.e2e\)\.length >= 2/);
  });
});
