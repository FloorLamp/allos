import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// THE REFILL POSTURE, PRINTED AT THE MOMENT OF FAILURE (owner, 2026-08-30).
// Two measured under-dispatch drifts: a few merges land and the session sits
// at one lane; after a recovery it announces "the lanes are empty" and stops.
// The refill rule existed in the skill the whole time — prose walked past,
// the usual way. So both roster surfaces now read the state back as a
// directive: an empty board is a dispatch order, a thin one is
// under-saturated, and "empty" is only honest beside the enumerated list of
// why each remaining issue cannot dispatch. These pins hold the directives to
// the surfaces an orchestrator actually reads.

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the refill directives", () => {
  it("the check-in reads an empty roster as a dispatch order", () => {
    const checkin = read("scripts/orchestrator-checkin.sh");
    expect(checkin).toContain("AN EMPTY ROSTER IS A DISPATCH ORDER");
    expect(checkin).toContain("UNDER-SATURATED");
    // The honesty clause: emptiness must come with the why-not list.
    expect(checkin).toContain("blocked, owner-gated, or dependency-bound");
  });

  it("`list` says the same on its empty and thin boards", () => {
    const brief = read("scripts/orchestration/dispatch-brief.mjs");
    expect(brief).toContain("DISPATCH ORDER, not calm");
    expect(brief).toContain("UNDER-SATURATED unless the queue is truly thin");
  });

  it("the skill and recovery runbook carry the posture the tooling prints", () => {
    expect(read(".claude/skills/orchestrate/SKILL.md")).toContain(
      "is a dispatch order, not a status"
    );
    expect(read("docs/orchestration/recovery.md")).toContain(
      "Recovery ends with a REFILL, not a report"
    );
  });
});
