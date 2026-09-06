// A RATCHET ON THE CI SKIP SET, AND NOTHING ELSE (owner, 2026-09-06).
//
// `.github/workflows/ci.yml` drops the twelve-shard browser matrix for a diff
// whose every path matches one literal alternation. A test or guard on dev
// config is forbidden — a config that is wrong fails the first time it runs, and
// a guard that restates it is a second copy of the config that can disagree with
// it. So this file no longer asserts what the entries ARE, only how many there
// are, because a silently GROWING skip set stops CI running the browser suite
// for entire diffs and nothing else would say so.
//
// WHAT THIS NO LONGER CATCHES: a WRONG entry, as opposed to a new one. An entry
// that names a directory the running app can in fact reach now fails silently —
// the browser matrix is skipped for a change that needed it — and the count
// below is unmoved. That cost is accepted; the count is the part worth keeping.
//
// IT COUNTS ONE OF TWO IDENTICAL COPIES. The same 13-entry alternation sits
// verbatim in `.github/workflows/e2e-main.yml`, which skips main's post-merge
// browser run, and this reads only `ci.yml`. So the count covers one file of the
// two: widen e2e-main.yml alone and nothing here moves. That is the same loss as
// the agreement check above, in the direction the count cannot see.
//
// N MAY ONLY EVER BE LOWERED, and lowering it belongs to the PR that removes the
// entry. Raising it is how a ratchet becomes a rubber stamp. No allowlist of
// names, no per-file registry, no import graph.
//
// N = 13, the entry count measured on 2b88249b3 with the parse below.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("the CI no-runtime-surface skip set", () => {
  it("has not grown", () => {
    const src = fs.readFileSync(
      path.join(REPO, ".github/workflows/ci.yml"),
      "utf8"
    );
    const match = /grep -qvE '\^\((.+?)\)'/.exec(src);
    expect(
      match,
      "ci.yml declares no `grep -qvE '^(…)'` skip set"
    ).not.toBeNull();
    expect(match![1].split("|").length).toBeLessThanOrEqual(13);
  });
});
