// When a lane may be RETIRED (#3212).
//
// Retiring is not tidying. `done` closes the ledger entry AND the roster row,
// and between them those are the worker's whole board — so retiring a lane
// whose PR is still open deletes the only record that the PR exists. On
// 2026-08-19 that happened to agent/3180-3206-test-hygiene: PR #3212 was open
// and green, the lane was retired, and the PR went untracked for an hour until a
// disk sweep noticed the abandoned worktree. Nothing was lost, and nothing would
// have found it either.
//
// The fact the guard reads is a REMOTE REF SURVIVING A PRUNE. Squash-merging
// deletes the remote head branch, so a remote still present after
// `git fetch --prune` means the work has not landed. That is the same fact the
// retirement path already computed — but it computed it AFTER removing the
// worktree, and only printed "(not merged?)" as prose. Both directions matter
// here, and the second is the one that was actually observed:
//
//   1. Remote gone ⇒ merged and tidied ⇒ retire. The ordinary path must not
//      start refusing, or every clean retirement becomes a manual override and
//      the guard gets routed around within the hour.
//   2. Remote alive ⇒ NOT merged ⇒ refuse. This is the regression.
//   3. --keep retires regardless, because a genuinely abandoned branch has to
//      have a way out that is not "delete the guard".

import { describe, expect, it } from "vitest";

import { retireVerdict } from "../../scripts/work/dispatch-brief.mjs";

describe("retireVerdict", () => {
  it("refuses while the remote branch survives a prune — the work has not landed", () => {
    expect(retireVerdict({ remoteAlive: true, keep: false })).toEqual({
      ok: false,
      reason: "unmerged",
    });
  });

  it("retires once the remote is gone, which IS the merged-and-tidied shape", () => {
    expect(retireVerdict({ remoteAlive: false, keep: false })).toEqual({
      ok: true,
      reason: "merged-and-tidied",
    });
  });

  it("lets --keep retire an abandoned branch either way", () => {
    // --keep closes the ledger entry and touches neither the branch nor the
    // tree, so there is nothing for the guard to protect.
    for (const remoteAlive of [true, false]) {
      expect(retireVerdict({ remoteAlive, keep: true })).toEqual({
        ok: true,
        reason: "keep",
      });
    }
  });

  it("decides on the remote alone — no other input can flip it", () => {
    // Guards in this file have twice been weakened by an extra condition that
    // read plausibly and made them unreachable. The verdict takes two facts;
    // pin that the second one only ever widens.
    expect(retireVerdict({ remoteAlive: true, keep: false }).ok).toBe(false);
    expect(retireVerdict({ remoteAlive: true, keep: true }).ok).toBe(true);
  });
});
