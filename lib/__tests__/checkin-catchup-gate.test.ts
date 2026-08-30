import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// THE CATCH-UP GATE (owner, 2026-08-30). catchup-digest.sh was designed to
// WRAP the flight recorder, but the runbook routes every wake at the recorder
// directly — so the digest only ran when a prompt happened to name it, the
// MCP-by-default drift class: a tool that waits to be remembered is a tool
// that isn't run. The recorder now routes: a stale anchor runs the digest
// from inside the check-in. These pins hold the three structural facts that
// make that safe — the gate exists, the recursion is guarded on both sides,
// and the two scripts read the same anchor.

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const checkin = read("scripts/orchestrator-checkin.sh");
const digest = read("scripts/orchestration/catchup-digest.sh");

describe("the check-in's catch-up gate", () => {
  it("the recorder runs the digest when the anchor is stale", () => {
    expect(checkin).toContain("catchup-digest.sh");
    // Staleness is the queue-sweep cadence, spelled as arithmetic so a silent
    // unit change fails here.
    expect(checkin).toContain("CATCHUP_DUE_SECS=$((4 * 3600))");
  });

  it("the recursion is guarded on BOTH sides, with the same flag", () => {
    // Recorder → digest sets the flag; digest → recorder honors it. One side
    // without the other is an infinite loop on the next stale anchor.
    expect(checkin).toContain("CATCHUP_SKIP_RECORDER=1 bash");
    expect(digest).toMatch(/if \[ "\$\{CATCHUP_SKIP_RECORDER:-0\}" != "1" \]/);
  });

  it("both scripts read the same anchor file", () => {
    for (const source of [checkin, digest]) {
      expect(source).toContain("/.last_catchup");
    }
  });

  it("a failed digest is announced, never silently swallowed", () => {
    expect(checkin).toContain("digest FAILED");
  });
});
