import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The overlay motion/gesture chokepoint (issue #1469).
//
// The app has three bottom/edge-anchored overlay surfaces — the mobile nav
// drawer, BottomSheet, and the activity dock's expanded editor. Their DISMISSAL
// contracts differ on purpose (#1428: the sheet discards, the dock minimizes)
// and must keep differing. Their MOTION and GESTURE MECHANICS must not: before
// this they carried three durations, two scrim treatments, two drag-handle
// geometries and zero shared recognizers, and the fourth surface would have made
// it four. Convergence that lives only in a code review is convergence that
// lasts one PR, so this scan is the thing that actually holds it.
//
// Four rules, each with an allowlist that must be justified in prose:
//
//   1. Every overlay surface consumes components/overlay.
//   2. A NEW full-viewport portal overlay must be classified — as a converged
//      surface or as a deliberately different anatomy — before it can ship.
//   3. No overlay surface hand-rolls a slide (raw transform/transition/keyframe).
//   4. The `.overlay-*` class names are produced by lib/motion.ts alone, and the
//      drag recognizer is components/overlay/useDragGesture.ts alone.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];

// The ONE home for each half of the primitive set.
const MOTION_HOME = "lib/motion.ts";
const RECOGNIZER_HOME = "components/overlay/useDragGesture.ts";
const OVERLAY_MODULE_DIR = "components/overlay/";

// ── Rule 1/3: the converged overlay surfaces ─────────────────────────────────
// Each of these renders a bottom- or edge-anchored panel over the whole viewport
// and must consume the shared primitives.
const OVERLAY_SURFACES = new Map<string, string>([
  [
    "components/BottomSheet.tsx",
    "the sheet — transactional lifecycle; swipe-down resolves to DISCARD (#1428)",
  ],
  [
    "components/MobileNav.tsx",
    "the nav drawer — edge-anchored; swipe-left resolves to CLOSE, edge-swipe opens (#1425)",
  ],
  [
    "components/ActivityOverlay.tsx",
    "the activity dock's expanded editor — session lifecycle; swipe-down resolves to MINIMIZE, never discard (#1428)",
  ],
  [
    "components/ProfileIdentityBar.tsx",
    "the mobile profile switcher — TOP-anchored; it drops from the identity bar and swipe-UP resolves to CLOSE, retreating through the bar it came from (#1801)",
  ],
]);

// ── Rule 2: portal overlays that are deliberately NOT this system ────────────
// #1469 scopes desktop dialogs and popovers out: different anatomy (centred, no
// bottom edge to flick toward, no safe-area inset to clear). They may adopt the
// tokens later; until then each one is recorded here on purpose.
const OTHER_PORTAL_OVERLAYS = new Map<string, string>([
  [
    "components/ModalShell.tsx",
    "the centred desktop modal — the sheet's non-thumb-reachable sibling; out of scope per #1469",
  ],
  [
    "components/MergeConflictDialog.tsx",
    "centred decision dialog, its own anatomy (no anchored edge)",
  ],
  [
    "components/PlateBuilderModal.tsx",
    "centred tool modal (barbell plate math) — a dialog, not an anchored panel",
  ],
  [
    "components/LevelBadge.tsx",
    "centred explainer popover over a full-viewport catcher",
  ],
  [
    "components/OverflowMenu.tsx",
    "a menu's full-viewport click-catcher — the menu itself is anchored to its trigger, not to a screen edge",
  ],
  [
    "components/ImageCropper.tsx",
    "the crop surface: its pointer drag manipulates CONTENT (the crop box), not the overlay's own position, so it is not a dismissal gesture at all",
  ],
]);

// ── Rule 4: modules allowed to own a raw drag listener ───────────────────────
const RAW_DRAG_LISTENER_ALLOW = new Map<string, string>([
  [
    RECOGNIZER_HOME,
    "the recognizer itself — the ONE place pointer streams are read",
  ],
  [
    "components/PullToRefresh.tsx",
    "overscroll pull (#1467): a different question (scroll position at the start, not axis arbitration on an element), with its own pure classifier in lib/pull-to-refresh.ts and a hard display-mode gate",
  ],
  [
    "components/ImageCropper.tsx",
    "drags the crop box within a fixed frame — content manipulation, not an overlay gesture",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      out.push(full);
  }
  return out;
}

interface SourceFile {
  rel: string;
  text: string;
}

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of walk(path.join(REPO, dir))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (
        rel.includes("__tests__") ||
        rel.includes("__db_tests__") ||
        rel.includes("__action_tests__")
      )
        continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

const FILES = sourceFiles();
const byPath = new Map(FILES.map((f) => [f.rel, f.text]));

// A full-viewport portal overlay, structurally: it portals itself out of the
// tree AND covers the viewport. That pair is what makes something an overlay
// regardless of what it is called.
function isPortalOverlay(text: string): boolean {
  return text.includes("createPortal") && text.includes("fixed inset-0");
}

// A hand-rolled slide: moving a panel with a transform/transition/keyframe the
// component wrote itself instead of taking the shared class.
const HAND_ROLLED_SLIDE: { pattern: RegExp; what: string }[] = [
  { pattern: /\btranslate-y-(?!0\b)/, what: "a Tailwind translate-y utility" },
  { pattern: /\btranslate-x-(?!0\b)/, what: "a Tailwind translate-x utility" },
  {
    pattern: /\btransition-transform\b/,
    what: "a Tailwind transform transition",
  },
  { pattern: /\bduration-\[/, what: "an arbitrary Tailwind duration" },
  { pattern: /@keyframes\b/, what: "an inline keyframe definition" },
  {
    pattern: /animation:\s*(?!none)/,
    what: "an inline `animation` declaration",
  },
];

describe("overlay motion chokepoint", () => {
  it("every converged overlay surface consumes components/overlay", () => {
    const offenders: string[] = [];
    for (const rel of OVERLAY_SURFACES.keys()) {
      const text = byPath.get(rel);
      if (text == null) {
        offenders.push(`${rel} (listed but not on disk)`);
        continue;
      }
      if (!/from ["'](?:@\/components\/overlay|\.\/overlay)["']/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "An overlay surface must take its motion classes, scrim, panel chrome, " +
        "drag handle and drag recognizer from components/overlay — that module " +
        "is what makes the drawer, the sheet and the dock ONE system with three " +
        "outcomes rather than three hand-rolled panels (#1469)."
    ).toEqual([]);
  });

  it("classifies every full-viewport portal overlay", () => {
    const unclassified = FILES.filter(
      (f) =>
        isPortalOverlay(f.text) &&
        !OVERLAY_SURFACES.has(f.rel) &&
        !OTHER_PORTAL_OVERLAYS.has(f.rel)
    ).map((f) => f.rel);
    expect(
      unclassified,
      "A new full-viewport portal overlay has to declare which system it is in. " +
        "If it is a bottom/edge-anchored panel, import components/overlay and add " +
        "it to OVERLAY_SURFACES with the outcome its swipe resolves to. If it is a " +
        "centred dialog or popover (different anatomy — #1469 scopes those out), " +
        "add it to OTHER_PORTAL_OVERLAYS with a one-line justification. The " +
        "reasoning for the split is docs/internals/overlays.md."
    ).toEqual([]);
  });

  it("no overlay surface hand-rolls a slide", () => {
    const offenders: string[] = [];
    for (const rel of OVERLAY_SURFACES.keys()) {
      const text = byPath.get(rel) ?? "";
      text.split("\n").forEach((line, i) => {
        // Prose describing the rule is not a violation of it.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        for (const { pattern, what } of HAND_ROLLED_SLIDE) {
          if (pattern.test(code)) offenders.push(`${rel}:${i + 1} — ${what}`);
        }
      });
    }
    expect(
      offenders,
      "This surface is animating itself. The overlay slide is ONE duration + " +
        "easing token pair (`--overlay-ms` / `--overlay-ease-*` in app/globals.css), " +
        "reached through `overlayMotionClass()` in lib/motion.ts; a finger-driven " +
        "transform goes through `useOverlayDrag`, which already owns the handshake " +
        "between an inline transform and a running keyframe."
    ).toEqual([]);
  });

  it("only lib/motion.ts names an `.overlay-*` animation class", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (rel === MOTION_HOME) continue;
      text.split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        // The mapper builds these names; everything else asks it for one.
        if (/["'`]overlay-(?:enter|exit)-/.test(code)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      "Call `overlayMotionClass(anchor, phase, reduceMotion)` instead of writing " +
        "the class name. It is the single place that knows the anchor vocabulary " +
        "AND that reduced motion means NO class at all — a hand-written class " +
        "string silently animates a viewer who asked it not to."
    ).toEqual([]);
  });

  it("only the shared recognizer reads a raw drag pointer stream", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (RAW_DRAG_LISTENER_ALLOW.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (
          /addEventListener\(\s*["'](?:pointermove|touchmove)["']/.test(code)
        ) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      "Gesture recognition lives in components/overlay/useDragGesture.ts, over the " +
        "pure lib/gesture.ts (axis lock, directed travel, distance-or-flick). " +
        "Consume `useDragGesture`/`useOverlayDrag` and supply the OUTCOME — that is " +
        "the one thing a gesture consumer is meant to decide (#1425/#1469). A " +
        "genuinely different gesture question goes in RAW_DRAG_LISTENER_ALLOW with " +
        "its reason, the way overscroll pull-to-refresh does. See " +
        "docs/internals/overlays.md."
    ).toEqual([]);
  });

  it("keeps the allowlists honest", () => {
    const stale: string[] = [];
    for (const rel of OTHER_PORTAL_OVERLAYS.keys()) {
      const text = byPath.get(rel);
      if (text == null) stale.push(`${rel} (gone from disk)`);
      else if (!isPortalOverlay(text))
        stale.push(`${rel} (no longer a portal overlay)`);
    }
    for (const rel of RAW_DRAG_LISTENER_ALLOW.keys()) {
      const text = byPath.get(rel);
      if (text == null) stale.push(`${rel} (gone from disk)`);
    }
    for (const [, why] of [...OVERLAY_SURFACES, ...OTHER_PORTAL_OVERLAYS]) {
      // A justification that says nothing is an allowlist entry nobody can review.
      expect(why.length).toBeGreaterThan(20);
    }
    expect(
      stale,
      "Remove the entry: an allowlist that outlives its reason is how the next " +
        "reviewer learns to ignore it."
    ).toEqual([]);
  });

  it("keeps the primitive modules where the failure messages say they are", () => {
    // The messages above send people to specific files; a rename that left them
    // pointing nowhere would make the guard actively unhelpful.
    expect(byPath.has(MOTION_HOME)).toBe(true);
    expect(byPath.has(RECOGNIZER_HOME)).toBe(true);
    expect(byPath.has("lib/gesture.ts")).toBe(true);
    expect(byPath.has(`${OVERLAY_MODULE_DIR}index.ts`)).toBe(true);
    expect(byPath.get(MOTION_HOME)).toMatch(
      /export function overlayMotionClass\b/
    );
    expect(byPath.get(RECOGNIZER_HOME)).toMatch(
      /export function useDragGesture\b/
    );
  });
});
