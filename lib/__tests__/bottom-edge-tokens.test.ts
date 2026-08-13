import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_EDGE_ABOVE_NAV,
  BOTTOM_EDGE_NAV_ROW_HEIGHT,
} from "@/components/overlay/tokens";

// The bottom-edge convention (issue #1520 part B, #2651) — a source scan in the
// shape of the overlay-motion chokepoint one level down, over the five FIXED
// surfaces that converge on the phone's bottom edge.
//
// The regression this freezes: each surface hand-wrote `bottom-[max(1rem,
// env(safe-area-inset-bottom))]` and picked a z-index in isolation, so a toast
// raised during a live workout landed ON TOP of the workout dock. The fix is not a
// slot manager — it is a documented stacking order plus shared class strings in
// components/overlay/tokens.ts, and claimants publishing their TOP EDGE into
// `--bottom-edge-offset`. That convergence only survives if a NEW bottom-anchored
// surface can't quietly re-hand-write the inset.
//
// #2651 is why the surface list is worth having: it added the phone nav dock under
// everything else, and the collision came straight back in a new place. Both base
// layers claim now, and the lift that clears the nav dock is a token rather than a
// number a second surface could get subtly different.
//
// Four rules:
//   1. Every bottom-edge surface consumes the shared tokens.
//   2. Both base layers claim the edge.
//   3. NOBODY outside components/overlay hand-writes the bottom-edge inset literal,
//      or the lift that clears the nav dock.
//   4. That lift agrees with the nav dock's own row height.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];
const TOKENS_HOME = "components/overlay/";

// The bottom-edge surfaces, and what each one is for. A new one is added here with
// its layer — that is the review moment this test exists to force.
const BOTTOM_EDGE_SURFACES = new Map<string, string>([
  [
    "components/MobileDock.tsx",
    "LAYER 0 (navigation) — the phone's nav dock, the floor of the edge; it claims the edge (#2651)",
  ],
  [
    "components/WorkoutDock.tsx",
    "LAYER 1 (session) — the full-width live-workout bar; it sits above the nav dock and claims the edge",
  ],
  [
    "components/Toast.tsx",
    "LAYER 2 — the toast stack, bottom-right; stacks above the dock instead of over it",
  ],
  [
    "components/OfflineQueueProvider.tsx",
    "LAYER 2 (pill, bottom-left) + LAYER 3 (rejected-writes panel, bottom-right)",
  ],
  [
    "components/UpdateReadyBar.tsx",
    "LAYER 2 — the deploy update offer (#1700), bottom-left, one row above the offline pill's slot so the two never overlap",
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

  it("both base layers claim the edge so the notice layers can clear them", () => {
    // Two claimants, not one. A base layer that renders without claiming is
    // invisible to every notice — which is exactly how #2651's nav dock started
    // out, with toasts landing on the bar they were tapped from.
    for (const file of [
      "components/MobileDock.tsx",
      "components/WorkoutDock.tsx",
    ]) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(src, `${file} must claim the bottom edge`).toContain(
        "useBottomEdgeClaim"
      );
    }
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

  it("nothing outside components/overlay hand-writes the lift over the nav dock", () => {
    // The #2651 twin of the rule above. The workout dock shipped this literal
    // inline; a second session-layer surface copying it is how the two start
    // disagreeing by a quarter rem.
    const HAND_WRITTEN =
      /bottom-\[calc\(3\.5rem\s*\+\s*env\(safe-area-inset-bottom\)\)\]/;
    const offenders = sourceFiles().filter(
      (file) =>
        !file.startsWith(TOKENS_HOME) &&
        !file.startsWith("lib/__tests__/") &&
        HAND_WRITTEN.test(fs.readFileSync(path.join(REPO, file), "utf8"))
    );
    expect(
      offenders,
      "hand-written nav-dock lift — use BOTTOM_EDGE_ABOVE_NAV from components/overlay"
    ).toEqual([]);
  });

  it("the lift agrees with the nav dock's own row height", () => {
    // Tailwind's spacing scale is 0.25rem per step, so `h-14` is 3.5rem. The lift
    // has to be a LITERAL (a runtime custom property would leave the workout dock
    // flush for the first paint and then jump it), so this is what stops the pair
    // drifting when the bar's height is next tuned.
    const step = Number(
      /^h-(\d+(?:\.\d+)?)$/.exec(BOTTOM_EDGE_NAV_ROW_HEIGHT)?.[1]
    );
    expect(
      step,
      "nav row height must be a Tailwind h-<n> class"
    ).toBeGreaterThan(0);
    const lift = /bottom-\[calc\((\d+(?:\.\d+)?)rem/.exec(
      BOTTOM_EDGE_ABOVE_NAV
    )?.[1];
    expect(Number(lift)).toBe(step * 0.25);
    // …and above `md` the nav dock does not render, so the lift drops back flush.
    expect(BOTTOM_EDGE_ABOVE_NAV).toContain("md:bottom-0");
  });
});
