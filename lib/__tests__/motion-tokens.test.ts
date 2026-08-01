import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MOTION_MS,
  OVERLAY_EASE_ENTER,
  OVERLAY_EASE_EXIT,
  OVERLAY_MOTION_MS,
  motionMs,
  overlayMotionClass,
} from "@/lib/motion";

// The overlay motion tokens (issue #1469) live in TWO places by necessity: the
// number in lib/motion.ts times the unmount (usePresence keeps an exiting panel
// mounted for exactly that long), and the same number in app/globals.css times
// the paint. They cannot be a single literal — one is JS, one is CSS — so they
// are pinned to each other here. A stylesheet that outlives its JS duration
// leaves a frozen panel on screen for a frame; one that undercuts it truncates
// the exit mid-slide. Both are the kind of bug nobody files and everybody feels.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CSS = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");

function cssVar(name: string): string {
  const match = CSS.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`${name} is not declared in app/globals.css`);
  return match[1].trim();
}

describe("overlay motion tokens", () => {
  it("declares the duration once in CSS and matches lib/motion.ts", () => {
    expect(cssVar("--overlay-ms")).toBe(`${OVERLAY_MOTION_MS}ms`);
  });

  it("declares the same easing pair in CSS", () => {
    expect(cssVar("--overlay-ease-enter")).toBe(OVERLAY_EASE_ENTER);
    expect(cssVar("--overlay-ease-exit")).toBe(OVERLAY_EASE_EXIT);
  });

  it("gives all three overlay surfaces the ONE duration", () => {
    // The convergence itself: before #1469 the drawer ran at 220ms, the sheet at
    // 240ms, and the dock had no animation at all.
    expect(MOTION_MS.drawer).toBe(OVERLAY_MOTION_MS);
    expect(MOTION_MS.sheet).toBe(OVERLAY_MOTION_MS);
    expect(MOTION_MS.dock).toBe(OVERLAY_MOTION_MS);
  });

  it("every overlay animation class is defined in the stylesheet", () => {
    for (const anchor of ["scrim", "bottom", "left", "top", "dialog"] as const) {
      for (const phase of ["enter", "exit"] as const) {
        const cls = overlayMotionClass(anchor, phase, false);
        expect(cls).toBe(`overlay-${phase}-${anchor}`);
        expect(CSS).toContain(`.${cls} {`);
      }
    }
  });

  it("drives every overlay animation from the token variables", () => {
    // No class may hard-code a duration or easing — that is exactly the drift
    // this issue closed. Each `.overlay-*` rule must reference the vars.
    const rules = (
      CSS.match(/\.overlay-(?:enter|exit)-[a-z]+ \{[^}]*\}/g) ?? []
    ).filter(
      // The reduced-motion block neutralizes the same selectors; it is asserted
      // separately below and has no duration to carry.
      (rule) => !/animation:\s*none/.test(rule)
    );
    expect(rules.length).toBeGreaterThanOrEqual(8);
    for (const rule of rules) {
      expect(rule, rule).toContain("var(--overlay-ms)");
      expect(rule, rule).toMatch(/var\(--overlay-ease-(enter|exit)\)/);
    }
  });

  it("suppresses every overlay animation under prefers-reduced-motion", () => {
    // Two independent guarantees, because either alone is one refactor from
    // failing: the mapper returns no class at all, AND the stylesheet neutralizes
    // the classes for anything that applies them another way.
    for (const anchor of ["scrim", "bottom", "left", "top", "dialog"] as const) {
      expect(overlayMotionClass(anchor, "enter", true)).toBe("");
      expect(overlayMotionClass(anchor, "exit", true)).toBe("");
    }
    const reduced = CSS.slice(
      CSS.indexOf(
        "@media (prefers-reduced-motion: reduce)",
        CSS.indexOf("--overlay-ms")
      )
    );
    for (const anchor of ["scrim", "bottom", "left", "top", "dialog"] as const) {
      expect(reduced).toContain(`.overlay-enter-${anchor}`);
      expect(reduced).toContain(`.overlay-exit-${anchor}`);
    }
    expect(reduced).toContain(".overlay-settle");
  });

  it("collapses every overlay duration to 0 under reduced motion", () => {
    // usePresence takes this number: 0 means the panel still mounts and unmounts
    // in the same order, it simply arrives (#794 8d / #1416 F).
    expect(motionMs("sheet", true)).toBe(0);
    expect(motionMs("drawer", true)).toBe(0);
    expect(motionMs("dock", true)).toBe(0);
  });
});
