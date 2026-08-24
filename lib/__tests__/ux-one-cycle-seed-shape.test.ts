import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cycleLengths,
  cycleLengthStatsState,
  cycleStats,
  type CyclePeriod,
} from "../cycle";
import { seedDialsFromEnv } from "../../scripts/seed-rng";
import {
  applyUxSeedShapeEnv,
  uxSeedRunInfo,
  uxSeedShapeFromEnv,
} from "../../scripts/ux-seed-shapes.mjs";
import { stripComments } from "./strip-comments";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function period(id: number, start: string): CyclePeriod {
  return {
    id,
    period_start: start,
    period_end: start,
    flow: "medium",
    note: null,
  };
}

function oneCycleShape() {
  const selection = uxSeedShapeFromEnv({ UX_SEED: "one-cycle" });
  expect(selection.kind).toBe("found");
  if (selection.kind !== "found") throw new Error("one-cycle shape not found");
  return selection.shape;
}

describe("UX_SEED=one-cycle (#3489 D5)", () => {
  it("labels and delivers the fixed middle-state vector through the child boundary", () => {
    const shape = oneCycleShape();
    expect(applyUxSeedShapeEnv({}, shape)).toEqual({
      SEED_DIAL_SHAPE: "one-cycle",
    });
    expect(uxSeedRunInfo(shape, {})).toEqual({
      uxSeed: "one-cycle",
      seedRng: null,
      seedPersona: null,
      seedDialShape: "one-cycle",
    });

    const dials = seedDialsFromEnv(applyUxSeedShapeEnv({}, shape));
    expect(dials.kind).toBe("named");
    if (dials.kind !== "named") return;
    expect(dials.dials).toEqual({
      illnessNow: "active",
      importQuirks: "clean",
      volume: "lean",
      gapiness: "continuous",
      textLength: "short",
      middleState: "one-completed-cycle",
    });
  });

  it("fails misspelled, entropy-conflicted, and persona-conflicted labels loudly", () => {
    expect(uxSeedShapeFromEnv({ UX_SEED: "one-cycles" })).toEqual({
      kind: "unknown",
      raw: "one-cycles",
      known: ["1", "thin", "dirty", "one-cycle"],
    });
    expect(uxSeedShapeFromEnv({ UX_SEED: "one-cycle", SEED_RNG: "3" })).toEqual(
      {
        kind: "conflict",
        raw: "one-cycle",
        reason:
          "UX_SEED=one-cycle pins a complete dial vector; remove SEED_RNG",
      }
    );
    expect(
      uxSeedShapeFromEnv({
        UX_SEED: "one-cycle",
        SEED_PERSONA: "household",
      })
    ).toEqual({
      kind: "conflict",
      raw: "one-cycle",
      reason:
        "SEED_PERSONA=household is set but UX_SEED=one-cycle — persona runs need UX_SEED=1, otherwise the census would label a differently-shaped DB with a persona it doesn't contain.",
    });
  });

  it("pins the off-by-one rule: two stored periods are one completed interval", () => {
    const first = period(1, "2026-01-01");
    const second = period(2, "2026-01-29");
    const third = period(3, "2026-02-26");
    expect(cycleLengths([first])).toEqual([]);
    expect(cycleLengths([first, second])).toEqual([
      {
        start: "2026-01-01",
        nextStart: "2026-01-29",
        days: 28,
      },
    ]);
    expect(cycleLengths([first, second, third])).toHaveLength(2);

    const stats = cycleStats([first, second]);
    expect(stats.cycleCount).toBe(1);
    expect(cycleLengthStatsState(stats)).toEqual({
      kind: "insufficient",
      message: "1 completed cycle — cycle length stats appear after 3.",
    });
  });

  it("keeps the live Cycle page on the shared model/UI gate", () => {
    const page = stripComments(
      fs.readFileSync(
        path.join(repo, "app/(app)/medical/cycles/page.tsx"),
        "utf8"
      )
    );
    expect(page).toContain(
      "const lengthStatsState = cycleLengthStatsState(stats);"
    );
    expect(page).toContain('lengthStatsState.kind === "ready"');
    expect(page).toContain("{lengthStatsState.message}");
    expect(page).not.toContain("insufficientLengthCopy");
  });

  it("is in the documented standard cadence as the one-cycle boundary", () => {
    const skill = fs.readFileSync(
      path.join(repo, ".claude/skills/ux-walkthrough/SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("Run all five census shapes");
    expect(skill).toContain(
      "UX_SEED=one-cycle node scripts/ux-walkthrough.mjs --serve pages"
    );
    expect(skill).toContain("stores exactly two periods");
    expect(skill).toContain("SEED_DIAL_SHAPE=one-cycle");
  });
});
