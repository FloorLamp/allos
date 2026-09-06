// A RATCHET ON THE DB GATE'S TRIGGER SET, AND NOTHING ELSE (owner, 2026-09-06).
//
// `scripts/orchestration/agent-gates.sh` runs the DB+action tier only when the
// diff touches `db_tier_paths`. A test or guard on dev config is forbidden — a
// config that is wrong fails the first time it runs, and a guard that restates
// it is a second copy of the config that can disagree with it. So this file no
// longer walks the tier's imports or asserts what the entries ARE, only how many
// there are, because a silently GROWING trigger set is the one failure nothing
// else would report.
//
// WHAT THIS NO LONGER CATCHES: a WRONG entry, as opposed to a new one. A set too
// narrow for what the tier actually imports still skips the DB tests for a diff
// that needed them, and a set widened back over docs/ or e2e/ still makes the
// expensive gate fire for everyone — neither moves the count below. That cost is
// accepted; the count is the part worth keeping.
//
// N MAY ONLY EVER BE LOWERED, and lowering it belongs to the PR that removes the
// entry. Raising it is how a ratchet becomes a rubber stamp. No allowlist of
// names, no per-file registry, no import graph.
//
// N = 19, the entry count measured on 2b88249b3 with the parse below.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("the test:db gate's trigger set", () => {
  it("has not grown", () => {
    const src = fs.readFileSync(
      path.join(REPO, "scripts/orchestration/agent-gates.sh"),
      "utf8"
    );
    const match = /db_tier_paths=\(\n([\s\S]*?)\n\)/.exec(src);
    expect(
      match,
      "agent-gates.sh declares no `db_tier_paths=( … )` array"
    ).not.toBeNull();
    const entries = match![1]
      .split("\n")
      .map((line) => line.trim().replace(/^["']|["']$/g, ""))
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(entries.length).toBeLessThanOrEqual(19);
  });
});
