import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// THE DIGEST IS THE PM'S (owner, 2026-09-02). catchup-digest.sh was an orchestrator's
// data pulse gated inside the check-in; the owner asked for a catch-up that
// answers three questions — what shipped for people, what went wrong and what
// changed because of it, how far we got — run from the PM session. These pins
// hold the structural facts: the orchestrator's check-in no longer runs a digest,
// the digest owns its own anchor, a failed read never advances it, and main's
// own detector is read through the merge gate's verdict function so the two
// surfaces cannot drift apart (#4722).

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const checkin = read("scripts/orchestrator-checkin.sh");
const digest = read("scripts/orchestration/pm-digest.sh");

describe("the PM digest", () => {
  it("is not run from the orchestrator's check-in", () => {
    expect(checkin).not.toContain("catchup-digest.sh");
    expect(checkin).not.toMatch(/bash .*pm-digest\.sh/);
    expect(checkin).not.toContain("CATCHUP_DUE_SECS");
  });

  it("answers the owner's three questions, in order", () => {
    const one = digest.indexOf("1. SHIPPED FOR PEOPLE");
    const two = digest.indexOf("2. INCIDENTS AND WHAT CHANGED BECAUSE OF THEM");
    const three = digest.indexOf("3. PROGRESS");
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it("owns its own anchor and never advances it past a failed read", () => {
    expect(digest).toContain("/.last_pm_digest");
    expect(digest).not.toContain("/.last_catchup");
    expect(digest).toContain("anchor NOT advanced");
  });

  it("reads the curated release notes from main, not the checkout", () => {
    expect(digest).toContain("origin/main:lib/release-notes.json");
  });

  it("reads main's own detector through the merge gate's verdict function", () => {
    expect(digest).toContain("/commits/main/check-runs");
    expect(digest).toContain("merge-gate-core.mjs");
    expect(digest).toMatch(/baseDetectorNotice\(\s*parsed\.check_runs/);
  });
});
