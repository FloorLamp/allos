import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seedDialsFromEnv } from "../../scripts/seed-rng";
import {
  applyUxSeedShapeEnv,
  uxSeedRunInfo,
  uxSeedShapeFromEnv,
} from "../../scripts/ux-seed-shapes.mjs";
import { stripComments } from "./strip-comments";

// #3489 D3. The dangerous failure is a label/data split: audit.md says "dirty"
// while scripts/seed.ts received a sampled or baseline vector. Drive the same
// two pure boundaries the live child-process path uses, then pin the small amount
// of executable wiring that connects them.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

function dirtyShape() {
  const selection = uxSeedShapeFromEnv({ UX_SEED: "dirty" });
  expect(selection.kind).toBe("found");
  if (selection.kind !== "found") throw new Error("dirty shape not found");
  return selection.shape;
}

describe("UX_SEED=dirty", () => {
  it("reaches the fixed dirty vector through the actual child env boundary", () => {
    const childEnv = applyUxSeedShapeEnv({}, dirtyShape());
    expect(childEnv).toEqual({
      SEED_DIAL_SHAPE: "dirty",
      SEED_REQUIRE_EMPTY: "1",
    });
    const dials = seedDialsFromEnv(childEnv);
    expect(dials.kind).toBe("named");
    if (dials.kind !== "named") return;
    expect(dials.dials).toEqual({
      illnessNow: "active",
      importQuirks: "quirky",
      volume: "lean",
      gapiness: "continuous",
      textLength: "long",
    });
  });

  it("clears an unlabeled direct shape from every other UX shape", () => {
    const seeded = uxSeedShapeFromEnv({ UX_SEED: "1" });
    expect(seeded.kind).toBe("found");
    if (seeded.kind !== "found") return;
    expect(
      applyUxSeedShapeEnv({ SEED_DIAL_SHAPE: "dirty" }, seeded.shape)
    ).toEqual({ SEED_REQUIRE_EMPTY: "1" });
  });

  it("fails unknown names and a conflicting entropy seed loudly", () => {
    expect(uxSeedShapeFromEnv({ UX_SEED: "dritty" })).toEqual({
      kind: "unknown",
      raw: "dritty",
      known: ["1", "thin", "dirty"],
    });
    expect(uxSeedShapeFromEnv({ UX_SEED: "dirty", SEED_RNG: "3" })).toEqual({
      kind: "conflict",
      raw: "dirty",
      reason: "UX_SEED=dirty pins a complete dial vector; remove SEED_RNG",
    });
    expect(
      uxSeedShapeFromEnv({ UX_SEED: "dirty", SEED_PERSONA: "household" })
    ).toEqual({
      kind: "conflict",
      raw: "dirty",
      reason:
        "SEED_PERSONA=household is set but UX_SEED=dirty — persona runs need UX_SEED=1, otherwise the census would label a differently-shaped DB with a persona it doesn't contain.",
    });
  });

  it.each([
    ["without --serve", ["pages"]],
    ["with --serve", ["--serve", "pages"]],
  ])("rejects a dirty/persona conflict %s", (_label, args) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UX_SEED: "dirty",
      SEED_PERSONA: "household",
    };
    delete env.SEED_RNG;
    delete env.SEED_DIAL_SHAPE;
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "ux-walkthrough.mjs"), ...args],
      { cwd: repo, env, encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SEED_PERSONA=household is set but UX_SEED=dirty — persona runs need UX_SEED=1"
    );
  });

  it("records the named shape independently in run.json data", () => {
    expect(uxSeedRunInfo(dirtyShape(), {})).toEqual({
      uxSeed: "dirty",
      seedRng: null,
      seedPersona: null,
      seedDialShape: "dirty",
    });
    const fresh = uxSeedShapeFromEnv({});
    expect(fresh.kind).toBe("found");
    if (fresh.kind !== "found") return;
    expect(uxSeedRunInfo(fresh.shape, {})).toEqual({
      uxSeed: null,
      seedRng: null,
      seedPersona: null,
      seedDialShape: null,
    });
  });

  it("keeps the live harness and seed entrypoint on these boundaries", () => {
    const walkthrough = stripComments(
      fs.readFileSync(path.join(repo, "scripts", "ux-walkthrough.mjs"), "utf8")
    );
    expect(walkthrough).toContain(
      "const UX_SEED_SELECTION = uxSeedShapeFromEnv(process.env);"
    );
    expect(walkthrough).toContain("const env = applyUxSeedShapeEnv(");
    expect(walkthrough).toContain("if (UX_SEED_SHAPE.seed)");
    expect(walkthrough).toMatch(
      /spawnSync\(\s*process\.execPath,\s*\["--import", "tsx", "scripts\/seed\.ts"\]/
    );
    expect(walkthrough).toContain(
      "seed exited non-zero for ${UX_SEED_SHAPE.label} — aborting"
    );
    expect(walkthrough).toContain(
      "const runInfo = uxSeedRunInfo(UX_SEED_SHAPE, process.env);"
    );

    const seed = stripComments(
      fs.readFileSync(path.join(repo, "scripts", "seed.ts"), "utf8")
    );
    expect(seed).toContain(
      "const DIAL_SELECTION = seedDialsFromEnv(process.env);"
    );
    expect(seed).toContain("const DIALS = DIAL_SELECTION.dials;");
  });

  it("is part of the documented standard rotation", () => {
    const skill = fs.readFileSync(
      path.join(repo, ".claude", "skills", "ux-walkthrough", "SKILL.md"),
      "utf8"
    );
    expect(skill).toContain("Run all four census shapes");
    expect(skill).toContain(
      "UX_SEED=dirty node scripts/ux-walkthrough.mjs --serve pages"
    );
    expect(skill).toContain("SEED_DIAL_SHAPE=dirty");
  });
});
