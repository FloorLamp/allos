import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The bottom-edge convention (issue #1520, part B) — a source scan in the shape of
// the overlay-motion chokepoint one level down, over the four FIXED surfaces that
// converge on the phone's bottom edge.
//
// The regression this freezes: each surface hand-wrote `bottom-[max(1rem,
// env(safe-area-inset-bottom))]` and picked a z-index in isolation, so a toast
// raised during a live workout landed ON TOP of the workout dock. The fix is not a
// slot manager — it is a documented stacking order plus shared class strings in
// components/overlay/tokens.ts, and ONE claimant (the dock) publishing its height
// into `--bottom-edge-offset`. That convergence only survives if a NEW
// bottom-anchored surface can't quietly re-hand-write the inset.
//
// Two rules:
//   1. Every bottom-edge surface consumes the shared tokens (and the dock, the base
//      layer, also claims its height).
//   2. NOBODY outside components/overlay hand-writes the bottom-edge inset literal.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];
const TOKENS_HOME = "components/overlay/";

// The bottom-edge surfaces, and what each one is for. A new one is added here with
// its layer — that is the review moment this test exists to force.
const BOTTOM_EDGE_SURFACES = new Map<string, string>([
  [
    "components/WorkoutDock.tsx",
    "LAYER 0 (base) — the full-width live-workout bar; it OWNS the edge and claims its height",
  ],
  [
    "components/Toast.tsx",
    "LAYER 1 — the toast stack, bottom-right; stacks above the dock instead of over it",
  ],
  [
    "components/OfflineQueueProvider.tsx",
    "LAYER 1 (pill, bottom-left) + LAYER 2 (rejected-writes panel, bottom-right)",
  ],
  [
    "components/UpdateReadyBar.tsx",
    "LAYER 1 — the deploy update offer (#1700), bottom-left, one row above the offline pill's slot so the two never overlap",
  ],
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.relative(REPO, full));
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(REPO, dir));
  return out;
}

describe("bottom-edge tokens (#1520)", () => {
  it("every bottom-edge surface consumes the shared tokens", () => {
    for (const [file, why] of BOTTOM_EDGE_SURFACES) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(
        src,
        `${file} (${why}) must import the bottom-edge tokens`
      ).toMatch(/BOTTOM_EDGE_[A-Z_]+/);
    }
  });

  it("the dock claims its height so the notice layers can clear it", () => {
    const src = fs.readFileSync(
      path.join(REPO, "components/WorkoutDock.tsx"),
      "utf8"
    );
    expect(src).toContain("useBottomEdgeClaim");
  });

  it("nothing outside components/overlay hand-writes the bottom-edge inset", () => {
    // The literal the four surfaces used to each carry a copy of. A new surface
    // that needs to sit at the bottom edge composes BOTTOM_EDGE_NOTICE_BOTTOM
    // (which resolves to exactly this when no base layer is claimed) instead.
    const HAND_WRITTEN =
      /bottom-\[max\(1rem,\s*env\(safe-area-inset-bottom\)\)\]/;
    const offenders = sourceFiles().filter(
      (file) =>
        !file.startsWith(TOKENS_HOME) &&
        !file.startsWith("lib/__tests__/") &&
        HAND_WRITTEN.test(fs.readFileSync(path.join(REPO, file), "utf8"))
    );
    expect(
      offenders,
      "hand-written bottom-edge inset — use BOTTOM_EDGE_NOTICE_BOTTOM from components/overlay"
    ).toEqual([]);
  });
});
