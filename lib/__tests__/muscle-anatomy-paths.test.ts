import { describe, expect, it } from "vitest";
import { MUSCLE_IDS } from "@/lib/lifts";
import {
  BODY_OUTLINE,
  MUSCLE_PATHS,
  VIEW_H,
  VIEW_W,
  type MuscleShape,
} from "@/lib/muscle-anatomy-paths";

// Reflection tests for the hand-authored anatomy registry (#737): the enum is
// walked against the path registry so a `MuscleId` can never be silently
// invisible on the figure — the exact failure the issue guards against. The
// registry is pure data (no React/DB), so this stays in the pure tier.

// The authoring convention: absolute commands only (M/L/C/Q/Z), which is what
// makes the shapes structurally checkable below.
const ALLOWED_CHARS = /^[MLCQZ0-9\s.,-]+$/;

/** All coordinate pairs of an absolute-command path. */
function coordPairs(d: string): [number, number][] {
  const nums = d
    .replace(/[MLCQZ]/g, " ")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  expect(nums.every((n) => Number.isFinite(n))).toBe(true);
  // Every absolute command used takes full (x, y) pairs.
  expect(nums.length % 2).toBe(0);
  const pairs: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) pairs.push([nums[i], nums[i + 1]]);
  return pairs;
}

function expectValidShape(d: string) {
  expect(d).toMatch(ALLOWED_CHARS);
  expect(d.trim().startsWith("M")).toBe(true);
  expect(d.trim().endsWith("Z")).toBe(true);
  const pairs = coordPairs(d);
  expect(pairs.length).toBeGreaterThan(2);
  for (const [x, y] of pairs) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(VIEW_W);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(VIEW_H);
  }
}

describe("MUSCLE_PATHS — the enum reflection guard", () => {
  it("maps every MuscleId to at least one path (no muscle silently invisible)", () => {
    for (const id of MUSCLE_IDS) {
      const shapes = MUSCLE_PATHS[id];
      expect(shapes, `MuscleId "${id}" has no path mapping`).toBeDefined();
      expect(
        shapes.length,
        `MuscleId "${id}" has an empty path list`
      ).toBeGreaterThan(0);
    }
  });

  it("carries no keys outside the MuscleId enum", () => {
    // The Record type enforces this at compile time; the runtime check keeps a
    // future `as`-cast or JSON-loaded registry honest.
    const known = new Set<string>(MUSCLE_IDS);
    for (const key of Object.keys(MUSCLE_PATHS)) {
      expect(known.has(key), `unknown registry key "${key}"`).toBe(true);
    }
  });

  it("every shape is a closed absolute-command path inside the view frame", () => {
    for (const id of MUSCLE_IDS) {
      for (const shape of MUSCLE_PATHS[id]) {
        expect(["front", "back"]).toContain(shape.view);
        expectValidShape(shape.d);
      }
    }
  });

  it("bilateral shapes are authored on the left half so mirroring yields the pair", () => {
    // The renderer mirrors bilateral shapes about x = VIEW_W / 2; a shape that
    // crosses meaningfully past the centerline would overlap its own twin.
    const centerline = VIEW_W / 2 + 1; // small tolerance for the seam overlap
    for (const id of MUSCLE_IDS) {
      for (const shape of MUSCLE_PATHS[id] as MuscleShape[]) {
        if (!shape.bilateral) continue;
        for (const [x] of coordPairs(shape.d)) {
          expect(
            x,
            `bilateral shape for "${id}" crosses the centerline`
          ).toBeLessThanOrEqual(centerline);
        }
      }
    }
  });
});

describe("BODY_OUTLINE", () => {
  it("both views carry a valid half-silhouette", () => {
    for (const view of ["front", "back"] as const) {
      expectValidShape(BODY_OUTLINE[view]);
    }
  });
});
