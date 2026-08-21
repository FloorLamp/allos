import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The overlay motion/gesture chokepoint (issue #1469).
//
// The app has three bottom/edge-anchored overlay surfaces — the mobile nav
// drawer, BottomSheet, and the activity workspace. Their lifecycle contracts
// differ on purpose. They share the overlay module's visual and gesture
// primitives; the activity workspace resolves its drag to minimize.
//
// Four rules, each with an allowlist that must be justified in prose:
//
//   1. Every overlay surface consumes components/overlay.
//   2. A NEW full-viewport portal overlay must be classified — as a converged
//      surface or as a deliberately different anatomy — before it can ship.
//   3. No overlay surface hand-rolls a slide (raw transform/transition/keyframe).
//   4. The `.overlay-*` class names are produced by lib/motion.ts alone, and the
//      drag recognizer is components/overlay/useDragGesture.ts alone.
//   5. A full-viewport overlay that SCROLLS ITSELF contains its overscroll, and
//      a portal dialog that hosts a FORM uses the converged host (#2774).
//   6. Every `presentation="centered"` call site — the recorded opt-out from the
//      phone sheet idiom — is registered with its justification (#2774).
//   7. Every ANCHORED MENU — a `role="menu"` panel positioned out of flow —
//      opens through components/overlay/AnchoredPanel.tsx, so it forks to a
//      bottom sheet below `md` instead of being a desktop context menu on a
//      phone (#3374).

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
    "the activity workspace — session lifecycle; its draggable bar minimizes rather than discards",
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
//
// components/ModalShell.tsx used to head this list. It is no longer here because
// it is no longer a portal at all: #2774 made it a thin WRAPPER over
// BottomSheet's `presentation="dialog"`, so its 34 consumers render the one
// responsive primitive — a sheet below `md`, a centred card above — and the app
// has one dialog implementation instead of two.
const OTHER_PORTAL_OVERLAYS = new Map<string, string>([
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
    "components/overlay/AnchoredPanel.tsx",
    "the anchored panel's DESKTOP half — a full-viewport click-catcher under a panel anchored to its trigger, not to a screen edge. Below `md` this same file mounts BottomSheet instead (#3374/#3376), so the phone presentation is already a converged surface",
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

// ── Rule 5b: portal dialogs allowed to host a form outside the converged host ─
// #2774 converged every form-hosting dialog onto ONE primitive. A raw portal
// that puts a form on screen beside it is the second engine growing back, so it
// has to say here why its form cannot live in the shared host.
const RAW_FORM_PORTAL_ALLOW = new Map<string, string>([]);

// ── Rule 6: the recorded opt-outs from the phone sheet idiom (#2774) ─────────
// The owner's decision is SHEETS ON PHONES for every converged consumer.
// `presentation="centered"` is the exception, and an exception is recorded, not
// smuggled: each surface here has an ANATOMY reason it is not flickable at any
// width. "It looks better centred" is not one of them.
const CENTERED_PRESENTATION = new Map<string, string>([
  [
    "components/CommandPalette.tsx",
    "the command palette — a keyboard surface whose body is a search field over a result list; no bottom edge to flick toward, and already scoped out of #1469",
  ],
  [
    "components/photo/PhotoCapture.tsx",
    "the camera fallback — a live viewfinder the user is aiming, where flick-to-dismiss is a gesture collision rather than an affordance",
  ],
]);

// ── Rule 7: the anchored menus, and the one that is deliberately not one ─────
//
// #3374 put the popover-or-sheet decision in ONE place. A hand-rolled anchored
// menu is that decision taken again, silently, for one surface — which is how
// thirty phone screens came to open a desktop context menu in the first place.
// The two spellings this repo actually uses are an `absolute`/`fixed` class on
// the panel and an inline `position: "fixed"` style; both are matched.
const ANCHORED_MENU_HOME = "components/overlay/AnchoredPanel.tsx";
const ANCHORED_MENU_EXCEPTIONS = new Map<string, string>([
  [
    "components/CompactDateMenu.tsx",
    "SMALL-MENU ANATOMY (#3374, implementer's call): a phone-only (`sm:hidden`) day switcher of two or three options, inline in a context heading, whose rows are already `min-h-11`. It is the control a viewer taps to GLANCE at another day and tap back; a modal sheet with a scrim, a focus trap and a scroll lock is a heavier answer than the question, and the clip risk the host exists to remove does not arise for a panel that opens at the top of the page beside its own heading. If it ever grows a long day list, it adopts the host.",
  ],
]);

// The panel element carrying `role="menu"`, and whether it is positioned out of
// normal flow — which is what makes a menu ANCHORED rather than inline. Returns
// the 1-based line of each anchored menu panel found.
//
// THE OPENING TAG IS FOUND BY BRACE DEPTH, not by the next `>`. The first
// attempt stopped at the first `>` after the role attribute and could not see
// components/CompactDateMenu.tsx at all: its very next attribute is an
// `onKeyDown={(event) => {` handler, and the arrow's `>` ended the tag twelve
// lines before the `className` that says `absolute`. A guard that reads half an
// element reports a clean sweep it never took.
export function anchoredMenuLines(text: string): number[] {
  const source = withoutComments(text);
  const lines: number[] = [];
  const re = /role=\{?["']menu["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) != null) {
    const tagStart = source.lastIndexOf("<", m.index);
    if (tagStart < 0) continue;
    const opening = openingTag(source, tagStart);
    const positioned =
      /className=[^\n]*\b(?:absolute|fixed)\b/.test(opening) ||
      /position:\s*["']fixed["']/.test(opening) ||
      /position:\s*["']absolute["']/.test(opening);
    if (positioned) lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

// The text of one JSX opening tag, from its `<` to the `>` that closes it at
// brace depth zero. Quoted strings are stepped over so an attribute value can
// contain any of these characters.
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

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

// The file with every comment blanked out but its LINE NUMBERS intact, so a
// scan reports the offending line and never the prose describing the rule. The
// per-line `//` strip the older rules do is not enough on its own: two of these
// scans first reported a `/* … */` block that merely NAMED `overflow-y-auto`
// and a doc comment that spelled `<form>`, which is the "checks a rendering of
// the property rather than the property" failure in its cheapest form.
function withoutComments(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      out.push(ch);
      continue;
    }
    if (inBlock) {
      if (ch === "*" && text[i + 1] === "/") {
        inBlock = false;
        out.push("  ");
        i += 1;
      } else out.push(" ");
      continue;
    }
    // A QUOTED STRING is copied through verbatim, comment openers and all. This
    // is not fussiness: `accept="image/*"` in components/photo/PhotoCapture.tsx
    // opened a phantom block comment that blanked the next 150 lines, and the
    // register scan below then reported the file as no longer opting out of the
    // sheet idiom — a scan reading a green it never checked, from source it had
    // silently thrown away.
    if (ch === '"' || ch === "'" || ch === "`") {
      out.push(ch);
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") {
          out.push(text[i], text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out.push(text[i]);
        i += 1;
      }
      out.push(text[i] ?? "");
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      inBlock = true;
      out.push("  ");
      i += 1;
      continue;
    }
    // A `//` comment runs to the end of the line, and anything inside it —
    // including a `/*` — is prose. Scanning left to right rather than running
    // two regexes over the whole file is what keeps that true.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      i -= 1;
      continue;
    }
    out.push(ch);
  }
  return out.join("");
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
      "An overlay surface must consume the shared primitives it uses from " +
        "components/overlay rather than hand-rolling a parallel system (#1469)."
    ).toEqual([]);
  });

  // Importing from components/overlay is not the same as USING the shared scrim.
  // #3099 dropped the check that the drawer's and the sheet's backdrops are one
  // token (`drawerScrim === sheetScrim`), and divergence now only takes writing a
  // class by hand — cheap to do, invisible in review, and nothing else notices.
  // Naming the constant is the observable form of "one scrim, two surfaces".
  it("the drawer and the sheet dress their backdrop from the shared scrim token", () => {
    const offenders: string[] = [];
    for (const rel of [
      "components/MobileNav.tsx",
      "components/BottomSheet.tsx",
    ]) {
      const text = byPath.get(rel);
      if (text == null) {
        offenders.push(`${rel} (listed but not on disk)`);
        continue;
      }
      // The identifier must be USED, not merely imported — an import the file
      // never applies is exactly the state this rules out. Matched on the bare
      // name outside the import statements, deliberately NOT on one spelling of
      // how it is applied: pinning `${OVERLAY_SCRIM}` failed a refactor to
      // `clsx(OVERLAY_SCRIM, …)` that is entirely correct, and a guard that
      // checks a SPELLING rather than the property is the failure that created
      // #3172 in the first place.
      //
      // `\b` does the work of telling the token apart from its siblings: after
      // `OVERLAY_SCRIM` in `OVERLAY_SCRIM_TINT` comes `_`, a word character, so
      // the boundary does not match there — a file that dressed its backdrop
      // with only the tint would still be reported.
      const body = text.replace(/import[\s\S]*?from\s*["'][^"']+["'];?/g, "");
      if (!/\bOVERLAY_SCRIM\b/.test(body)) offenders.push(rel);
    }
    expect(
      offenders,
      "MobileNav and BottomSheet must both dress their backdrop with OVERLAY_SCRIM " +
        "from components/overlay, so the two scrims cannot drift apart (#3172)."
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

  // THE #2774 DEFECT, stated where a new surface will meet it. ModalShell
  // rendered `fixed inset-0 overflow-y-auto` and scrolled ITSELF over an
  // unlocked body: a drag its scroller declined chained straight out to the
  // document, so the page underneath drifted and on release sat somewhere other
  // than where the dialog was opened from. Every other full-viewport overlay in
  // the app has the same shape available to it for the price of one class.
  //
  // Matched per CLASS STRING rather than per file, because "the file mentions
  // overscroll-contain somewhere" is exactly the cheaper question: a file with
  // two scrollers, one of them contained, would pass it while still chaining.
  it("a full-viewport overlay's own scroller contains its overscroll", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (!isPortalOverlay(text)) continue;
      withoutComments(text)
        .split("\n")
        .forEach((code, i) => {
          if (!/\boverflow-y-auto\b/.test(code)) return;
          if (/\boverscroll-contain\b/.test(code)) return;
          offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(
      offenders,
      "This scroller is inside a surface that covers the viewport, so when it " +
        "declines a drag the document takes it and the page moves BEHIND the " +
        "overlay (#2774). Add `overscroll-contain` to the same element. A locked " +
        "body is the other half of the answer and not a substitute: the lock is " +
        "held only while the surface is mounted, and a nested surface can release " +
        "it first."
    ).toEqual([]);
  });

  it("a portal dialog that hosts a form uses the converged host", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (!isPortalOverlay(text)) continue;
      if (OVERLAY_SURFACES.has(rel)) continue;
      if (RAW_FORM_PORTAL_ALLOW.has(rel)) continue;
      if (!/<form[\s>]/.test(withoutComments(text))) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      "A dialog that puts a FORM on screen renders through the converged host " +
        "(components/ModalShell.tsx, a thin wrapper over BottomSheet's " +
        '`presentation="dialog"`), so it inherits the sheet-below-`md` ' +
        "presentation, the locked body, the one scroll owner, the declared size " +
        "and the dirty-discard confirm. Hand-rolling the portal re-creates the " +
        "second dialog primitive #2774 retired. If the form genuinely cannot live " +
        "there, add the file to RAW_FORM_PORTAL_ALLOW with the reason. See " +
        "docs/internals/overlays.md's host decision table."
    ).toEqual([]);
  });

  it("records every opt-out from the phone sheet idiom", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (!/presentation=\{?["']centered["']/.test(withoutComments(text)))
        continue;
      if (CENTERED_PRESENTATION.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      "Sheets on phones is the decision for every converged consumer (#2774). " +
        '`presentation="centered"` opts a surface out of it, and an opt-out is ' +
        "RECORDED, not smuggled: add the file to CENTERED_PRESENTATION with the " +
        "ANATOMY reason it is not flickable at any width — the way the command " +
        "palette and the camera fallback are."
    ).toEqual([]);
    // And the register does not outlive its call sites.
    const stale = [...CENTERED_PRESENTATION.keys()].filter(
      (rel) =>
        !/presentation=\{?["']centered["']/.test(
          withoutComments(byPath.get(rel) ?? "")
        )
    );
    expect(
      stale,
      "This surface no longer opts out of the sheet idiom — drop it from the " +
        "register rather than leaving the next reader to check."
    ).toEqual([]);
    for (const [, why] of CENTERED_PRESENTATION) {
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("every anchored menu opens through the shared host", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (rel === ANCHORED_MENU_HOME) continue;
      if (ANCHORED_MENU_EXCEPTIONS.has(rel)) continue;
      for (const line of anchoredMenuLines(text))
        offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      'This file positions a `role="menu"` panel itself. Menu presentation is ' +
        "ONE decision (#3374): components/overlay/AnchoredPanel.tsx opens a menu " +
        "as a bottom action sheet below `md` and as a trigger-anchored popover " +
        "above it, so a phone never gets a desktop context menu. Render the items " +
        "through it — the panel's role, id, testid and key handling are all props " +
        "— or add the file to ANCHORED_MENU_EXCEPTIONS with the ANATOMY reason it " +
        "is not one of these menus."
    ).toEqual([]);
    // And the register does not outlive its call sites.
    const stale = [...ANCHORED_MENU_EXCEPTIONS.keys()].filter(
      (rel) => anchoredMenuLines(byPath.get(rel) ?? "").length === 0
    );
    expect(
      stale,
      "This surface no longer hand-rolls an anchored menu — drop it from the " +
        "register rather than leaving the next reader to check."
    ).toEqual([]);
    for (const [, why] of ANCHORED_MENU_EXCEPTIONS) {
      expect(why.length).toBeGreaterThan(20);
    }
  });

  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN
  // SEE. These fixtures are written to break the rule above in each spelling the
  // repo actually uses — and, just as important, to be IGNORED where a menu is
  // not anchored at all. components/encounters/VisitFactRow.tsx is the live
  // instance of that second case: a `role="menu"` chip row laid out in normal
  // flow, which is not a popover and must never be dragged into a sheet.
  it("the anchored-menu scan can see a hand-rolled menu, in either spelling", () => {
    const classNameSpelling = `
      <div role="menu" className="absolute top-full left-0 min-w-44 bg-surface">
        <button role="menuitem">Edit</button>
      </div>`;
    const inlineStyleSpelling = `
      <div
        role="menu"
        style={{ position: "fixed", top: pos.top, left: pos.left }}
      >
        <button role="menuitem">Edit</button>
      </div>`;
    // The shape that defeated the first version of this scan: an arrow-function
    // handler between the role and the className, whose `=>` looks like the end
    // of the opening tag.
    const handlerBeforeClassName = `
      <span
        role="menu"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") moveFocus(1);
        }}
        className="absolute top-full left-0 mt-1 min-w-44 bg-surface"
      >
        <button role="menuitem">Yesterday</button>
      </span>`;
    expect(anchoredMenuLines(classNameSpelling)).toHaveLength(1);
    expect(anchoredMenuLines(inlineStyleSpelling)).toHaveLength(1);
    expect(anchoredMenuLines(handlerBeforeClassName)).toHaveLength(1);

    // Silent on the benign neighbours: an inline chip menu, and PROSE that
    // merely describes the construct.
    const inlineFlowMenu = `
      <span role="menu" aria-label="Add another detail" className="inline-flex flex-wrap gap-1.5">
        <button role="menuitem">Blood pressure</button>
      </span>`;
    const prose = `
      // A row's role="menu" panel used to sit in an absolute container here.
      /* role="menu" with className="fixed inset-0" was the old shape. */`;
    expect(anchoredMenuLines(inlineFlowMenu)).toEqual([]);
    expect(anchoredMenuLines(prose)).toEqual([]);
    // And the live inline-flow menu in the tree stays unreported.
    expect(
      anchoredMenuLines(
        byPath.get("components/encounters/VisitFactRow.tsx") ?? ""
      )
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
    for (const rel of ANCHORED_MENU_EXCEPTIONS.keys()) {
      if (!byPath.has(rel)) stale.push(`${rel} (gone from disk)`);
    }
    for (const rel of RAW_FORM_PORTAL_ALLOW.keys()) {
      const text = byPath.get(rel);
      if (text == null) stale.push(`${rel} (gone from disk)`);
      else if (!/<form[\s>]/.test(withoutComments(text)))
        stale.push(`${rel} (no longer hosts a form)`);
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
    expect(byPath.has(ANCHORED_MENU_HOME)).toBe(true);
    expect(byPath.get(MOTION_HOME)).toMatch(
      /export function overlayMotionClass\b/
    );
    expect(byPath.get(RECOGNIZER_HOME)).toMatch(
      /export function useDragGesture\b/
    );
  });
});
