import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMobilityMoves } from "@/scripts/gen-mobility-moves";
import {
  MOBILITY_MOVES,
  mobilityMoveSlugs,
  mobilityMoveBySlug,
  canonicalMobilityMove,
  isValidMobilityMove,
  mobilityMoveName,
} from "@/lib/mobility-moves";
import { MUSCLE_IDS, muscleRegion } from "@/lib/lifts";

// Anti-drift pins for the curated mobility-move catalog (issue #840): the committed
// lib/datasets/data/mobility-moves.json is a FIXED POINT of the generator; every slug
// resolves a kind + description + at least one REAL MuscleId (so the coverage strip's
// muscleRegion() rollup is total); slugs are unique, snake_case, and stable. Pure — no
// DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/mobility-moves.json");

const MUSCLE_SET = new Set(MUSCLE_IDS);

describe("mobility-moves.json dataset", () => {
  it("is a fixed point of buildMobilityMoves() (regenerate with `npm run gen:mobility-moves`)", () => {
    const generated = JSON.stringify(buildMobilityMoves(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("has a healthy number of moves (habit tier ~20–30)", () => {
    expect(MOBILITY_MOVES.length).toBeGreaterThanOrEqual(20);
    expect(MOBILITY_MOVES.length).toBeLessThanOrEqual(30);
  });

  it("every slug resolves a kind, description, and at least one real MuscleId", () => {
    const slugs = mobilityMoveSlugs();
    expect(new Set(slugs).size).toBe(slugs.length); // unique
    for (const m of MOBILITY_MOVES) {
      expect(m.slug, m.slug).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(m.name.trim().length, m.slug).toBeGreaterThan(0);
      expect(["hold", "reps"], m.slug).toContain(m.kind);
      expect(m.description.trim().length, m.slug).toBeGreaterThan(0);
      expect(m.muscles.length, m.slug).toBeGreaterThan(0);
      for (const mid of m.muscles) {
        expect(MUSCLE_SET.has(mid), `${m.slug}→${mid}`).toBe(true);
        // Every tagged muscle rolls up to a region (totality of the coverage strip).
        expect(muscleRegion(mid), `${m.slug}→${mid}`).toBeTruthy();
      }
    }
  });

  it("resolves slugs through the matcher and refuses unknown ones (#203/#883)", () => {
    const first = MOBILITY_MOVES[0];
    expect(isValidMobilityMove(first.slug)).toBe(true);
    expect(mobilityMoveBySlug(first.slug)?.name).toBe(first.name);
    // Canonicalization: a fuzzy variant resolves to the exact stored slug.
    expect(canonicalMobilityMove(first.slug.replace(/_/g, "-"))).toBe(first.slug);
    // Refusal gate + graceful name fallback for an unknown slug.
    expect(isValidMobilityMove("__not_a_move__")).toBe(false);
    expect(canonicalMobilityMove("__not_a_move__")).toBeNull();
    expect(mobilityMoveName("__not_a_move__")).toBe("__not_a_move__");
  });
});
