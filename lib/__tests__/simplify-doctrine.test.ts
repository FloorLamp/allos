import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SIMPLIFY, EXTRACT, UNIFY — the 2026-08-27 line budget's positive half
// (owner, 2026-08-31): most work should leave the code smaller or straighter,
// invariants are enforced with TYPES rather than guards/registries, and
// adding complexity is the signal to stop and re-ask what the real goal
// costs in less code. The doctrine is only real where the workers read it,
// so these pins hold it to all three surfaces: the brief every lane
// receives, the reviewer's checklist, and the filing skill that shapes
// proposals before any lane exists.

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the simplify-extract-unify doctrine", () => {
  it("every dispatch brief carries it beside the line budget", () => {
    const brief = read("scripts/orchestration/dispatch-brief.mjs");
    expect(brief).toContain(
      "SIMPLIFY, EXTRACT, UNIFY — OWNER RULING 2026-08-31"
    );
    expect(brief).toContain("Enforce invariants with TYPES, not guards");
    expect(brief).toContain("what is the REAL GOAL");
    // It rides WITH the ruling it completes, so neither is read alone.
    expect(brief).toContain("LINE BUDGET, OWNER RULING 2026-08-27");
  });

  it("the reviewer's checklist enforces types-over-guards", () => {
    const review = read("docs/orchestration/review-merge.md");
    expect(review).toContain("Prefer TYPES over guards (owner 2026-08-31)");
    expect(review).toContain("unrepresentable");
    // The convergence rule now cites its ruling, so the date resolves from
    // the runbook and not only from the brief template.
    expect(review).toContain("(owner 2026-08-27)");
  });

  it("the filing skill shapes proposals toward the simplest shape", () => {
    const skill = read(".claude/skills/file-issue/SKILL.md");
    expect(skill).toContain("Simplest shape (owner, 2026-08-31)");
    expect(skill).toContain("TYPES over");
    expect(skill).toContain("DELETES or straightens");
  });
});
