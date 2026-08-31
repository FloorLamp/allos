import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

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
//   2. A NEW full-viewport overlay must be classified — as a converged surface or
//      as a deliberately different anatomy — before it can ship. NOT just a
//      PORTALLED one (#3405): see isFullViewportOverlay.
//   3. No overlay surface hand-rolls a slide (raw transform/transition/keyframe).
//   4. The `.overlay-*` class names are produced by lib/motion.ts alone, and the
//      drag recognizer is components/overlay/useDragGesture.ts alone.
//   5. A full-viewport overlay that SCROLLS ITSELF contains its overscroll, and
//      a full-viewport dialog that hosts a FORM uses the converged host (#2774).
//   6. Every `presentation="centered"` call site — the recorded opt-out from the
//      phone sheet idiom — is registered with its justification (#2774).
//   7. Every ANCHORED MENU — a `role="menu"` panel positioned out of flow —
//      opens through components/overlay/AnchoredPanel.tsx, so it forks to a
//      bottom sheet below `md` instead of being a desktop context menu on a
//      phone (#3374).
//   8. No consumer hands the host a NO-OP `onClose`. The host draws a real ✕; a
//      handler that does nothing makes it a control that lies. Pass
//      `closeDisabled` instead (#3405 review).

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
]);

// ── Rule 2: full-viewport overlays that are deliberately NOT this system ─────
// #1469 scopes desktop dialogs and popovers out: different anatomy (centred, no
// bottom edge to flick toward, no safe-area inset to clear). They may adopt the
// tokens later; until then each one is recorded here on purpose.
//
// components/ModalShell.tsx used to head this list. It is no longer here because
// it is no longer a portal at all: #2774 made it a thin WRAPPER over
// BottomSheet's `presentation="dialog"`, so its 34 consumers render the one
// responsive primitive — a sheet below `md`, a centred card above — and the app
// has one dialog implementation instead of two.
//
// LEVELBADGE LEFT IN #3445, the same way, and its ENTRY HERE WAS WRONG while it
// lasted. It read "centred explainer popover over a full-viewport catcher", and
// the CompactDateMenu row below cited it as the same shape as a transparent
// catcher. It was not: the layer carried `bg-slate-900/40 dark:bg-black/70` —
// OVERLAY_SCRIM_TINT verbatim — and held a centred card with a heading and a ✕,
// which is a modal dialog with the ARIA left off. That is why the dialog census
// could not see it either, and both registers described it from the same wrong
// premise. It renders ModalShell now, so it is not a full-viewport overlay at all.
//
// TWO MORE LEFT THIS LIST IN #3405, and by converging rather than by renaming:
// MergeConflictDialog and PlateBuilderModal are ordinary ModalShell consumers now,
// so they are not full-viewport surfaces at all. FOUR ARRIVED at the same time,
// and none of them is new — they are the surfaces the `createPortal` requirement
// hid (see isFullViewportOverlay). Each carries the anatomy reason it is not one
// of the converged overlay surfaces, which is what this register has always been
// for; docs/internals/overlays.md owns the separate dialog-host decision.
const OTHER_FULL_VIEWPORT_OVERLAYS = new Map<string, string>([
  [
    "components/CompactDateMenu.tsx",
    "NOT A PANEL AT ALL — its `fixed inset-0 z-20` is a transparent CLICK-CATCHER underneath an anchored day menu. Nothing is drawn on it, it holds no content and it traps no focus, so there is no overlay anatomy here to converge. The MENU above it is answered by rule 7, where this file is a recorded ANCHORED_MENU_EXCEPTIONS entry with its own reason",
  ],
  [
    "components/activity-form/FitnessTestTimer.tsx",
    "the fitness-test wall-clock takeover, nested INSIDE an already-open entry sheet: it carries no scrim because the sheet below it is already scrimmed, and it must stay MOUNTED when it collapses (the run lives in it), which is the opposite of a transactional sheet's lifecycle. A recorded dialog-host exception too — docs/internals/overlays.md",
  ],
  [
    "components/photo/PhotoGallery.tsx",
    "the photo lightbox: a full-bleed media viewer on a black ground with its own left/right paging, where a bottom-anchored panel has nothing to anchor to and swipe-to-dismiss would fight the paging gesture. A recorded dialog-host exception too — docs/internals/overlays.md",
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
  [
    "components/IntradayChart.tsx",
    "the day chart's horizontal ZOOM-BRUSH (#1068/#1515): the drag selects a minute RANGE on the chart's own axis — content manipulation, like ImageCropper's crop box — and it deliberately takes no pointer capture so the ticks and blocks underneath keep their clicks. `touch-pan-y` leaves the vertical scroll to the page, so there is no axis arbitration for the shared recognizer to do. FOUND BY THE WIDENED PATTERN BELOW when #3958 closed #2816's blind spot: it had been a third unlisted JSX recognizer the whole time",
  ],
  [
    "components/JumpRailScrubber.tsx",
    "the jump rail (#2657 item 4): its drag positions a DOCUMENT SCROLL OFFSET against a fold spine, not an overlay's own position, so there is no dismissal to classify and no axis to arbitrate (the strip carries `touch-none`). Same reasoning as the pull-to-refresh exception, with its own pure classifier in lib/timeline-scrubber.ts. Unlisted until #3958 only because rule 5 could not see a JSX-prop recognizer — that blind spot is closed below",
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
    "the command palette — a keyboard surface whose body is a search field over a result list: no bottom edge to flick toward at any width, and already scoped out of #1469. But that argument never defended a centred CARD either, and a floating card is what shipped to phones — so below `md` the same host renders it full-screen (#3423, `fullScreenBelowMd`). Still not a sheet; no longer a desktop dialog on a phone",
  ],
  [
    "components/media/MediaInput.tsx",
    "the shared add-media surface (#3286) — it hosts a live viewfinder the user is AIMING, where flick-to-dismiss is a gesture collision rather than an affordance. The dialog now opens on a chooser more often than on the camera, but the exception is anatomy, not statistics: one dismissal gesture for a surface whose camera stage is one tap away is what keeps the two stages from disagreeing about how you leave them",
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
  if (!/role=\{?["']menu["']/.test(text)) return [];
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

const RETIRED_MOBILE_IDENTITY_LITERAL = /surface="mobile"|search-mobile/;
const RETIRED_MOBILE_IDENTITY_TOLERANT =
  /(?:IdentitySurface|surface)[\s\S]{0,24}["']mobile["']|search\s*-\s*mobile/;

// A full-viewport overlay, structurally: it covers the viewport. That single fact
// is what makes something an overlay, regardless of what it is called.
//
// THE `createPortal` HALF IS GONE (#3405, owner ruling 2026-08-20), and dropping
// it is the whole point of that ruling rather than a tidy-up. This used to read
// `text.includes("createPortal") && text.includes("fixed inset-0")`, and the
// conjunction is exactly why the guard could not see THREE of the hostless
// dialogs the census found: PhotoGallery, FitnessTestTimer and FitnessCheckView
// never portal at all — they render `fixed inset-0` inline — so
// they sat outside every rule below BY CONSTRUCTION, not by exemption and not by
// anyone's decision. FitnessCheckView shipped the #2774 overscroll defect through
// three sweeps of its own family that way (#3421).
//
// THE COST IS STATED, so the first wave of failures is not read as a regression:
// every `fixed inset-0` surface now answers to these rules, and some legitimately
// should not — a full-bleed chart, a camera viewfinder. Those become RECORDED
// exceptions in the registers below with an anatomy reason, which is the same
// bargain #1469 struck for the portalled half.
//
// COMMENTS ARE STRIPPED FIRST, and that is not cosmetic either: with the portal
// half gone, a file that merely NAMES `fixed inset-0` in prose would be dragged in.
// Two do — components/ModalShell.tsx's history note quotes the exact class string
// it stopped rendering, and components/OverflowMenu.tsx describes its catcher. The
// host would then have been reported as an unclassified overlay by a guard reading
// a paragraph about why it is not one.
function isFullViewportOverlay(text: string): boolean {
  if (!/\bfixed inset-0\b/.test(text)) return false;
  return /\bfixed inset-0\b/.test(withoutComments(text));
}

// The 1-based lines of this file's own scrollers that do NOT contain their
// overscroll.
//
// Matched per CLASS STRING rather than per file, because "the file mentions
// overscroll-contain somewhere" is exactly the cheaper question: a file with two
// scrollers, one of them contained, would pass it while still chaining.
function uncontainedScrollerLines(text: string): number[] {
  if (!/\boverflow-y-auto\b/.test(text)) return [];
  const lines: number[] = [];
  withoutComments(text)
    .split("\n")
    .forEach((code, i) => {
      if (!/\boverflow-y-auto\b/.test(code)) return;
      if (/\boverscroll-contain\b/.test(code)) return;
      lines.push(i + 1);
    });
  return lines;
}

// The 1-based lines where a dialog host is handed an `onClose` that does nothing.
//
// THE OPENING TAG IS READ BY BRACE DEPTH, the same way anchoredMenuLines reads
// one, and for the same reason: an `onKeyDown={(e) => {` between the element name
// and `onClose` ends the tag at its arrow if you stop at the next `>`, and the
// scan then reports a clean sweep it never took.
//
// AND THE HANDLER IS RESOLVED THROUGH ITS LOCAL BINDINGS, which is the part the
// first version of this scan got wrong and only a mutation test caught. It matched
// the attribute VALUE — an inline `() => {}`, or the literal name `noop` — and the
// real regression was spelled neither way. What #3405's review actually found was
//
//     const close = busy ? noop : onCancel;
//     …
//     <ModalShell onClose={close} …>
//
// where the attribute reads `close` and says nothing at all. Restoring that exact
// shape left the guard GREEN, which is the "encode the issue's spelling rather than
// the repo's" failure in its purest form: a rule that cannot see the one instance
// it was written for. So a no-op-ness set is seeded from the empty functions the
// file declares and then propagated through the bindings that reference them, to a
// fixpoint; the attribute is checked against that set.
export function noOpCloseLines(text: string): number[] {
  if (!/<(?:ModalShell|BottomSheet)\b/.test(text) || !/onClose\s*=/.test(text))
    return [];
  const source = withoutComments(text);

  const EMPTY_BODY = String.raw`\(\s*\)\s*=>\s*(?:\{\s*\}|undefined\b)`;
  const noOpNames = new Set<string>();
  // Seed: a function or arrow whose body does nothing.
  for (const m of source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*\}/g
  ))
    noOpNames.add(m[1]);
  for (const m of source.matchAll(
    new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${EMPTY_BODY}`,
      "g"
    )
  ))
    noOpNames.add(m[1]);

  // Propagate: `const close = busy ? noop : onCancel` is a handler that MAY do
  // nothing, and "may" is the whole defect — the branch that does nothing is the
  // one the ✕ is live during. Two passes reach every chain this repo writes; a
  // third would only chase a rename of a rename.
  const bindings = [
    ...source.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*(?:\n[^;\n]*)*?);/g
    ),
  ];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [, name, expr] of bindings) {
      if (noOpNames.has(name)) continue;
      if ([...noOpNames].some((n) => new RegExp(`\\b${n}\\b`).test(expr)))
        noOpNames.add(name);
    }
  }

  const lines: number[] = [];
  const re = /<(?:ModalShell|BottomSheet)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) != null) {
    const opening = openingTag(source, m.index);
    const attr = /onClose=\{([\s\S]*?)\}\s*(?:[a-zA-Z-]+=|\/?>)/.exec(opening);
    const value = attr?.[1] ?? "";
    const empty =
      new RegExp(EMPTY_BODY).test(value) ||
      [...noOpNames].some((n) => new RegExp(`\\b${n}\\b`).test(value));
    if (empty) lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/** Does this file put a `<form>` on screen itself? */
function hostsRawForm(text: string): boolean {
  if (!/<form[\s>]/.test(text)) return false;
  return /<form[\s>]/.test(withoutComments(text));
}

// The file with every comment blanked out but its LINE NUMBERS intact, so a scan
// reports the offending line and never the prose describing the rule. This used to
// carry another hand-written TypeScript scanner and run it over the same 2,528-file
// corpus in six guards. The shared scanner is the verified language projection
// (#3621); memoizing it here keeps these rules about overlays rather than comments.
//
// Measured at conversion: the shared scanner read 28 of 2,528 files differently
// (mostly JSX text and regex-literal shapes the local scanner did not model), and all
// 21 overlay rules stayed green. Call sites reject impossible candidates against the
// raw text before reaching this projection; a possible match still comes through here,
// so comments never decide a rule's verdict. The cache is file-local because its
// inputs are the immutable source snapshots above; planted strings still exercise the
// same scanner.
const withoutCommentsCache = new Map<string, string>();
function withoutComments(text: string): string {
  const cached = withoutCommentsCache.get(text);
  if (cached !== undefined) return cached;
  const code = stripComments(text);
  withoutCommentsCache.set(text, code);
  return code;
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
  it("has one unsuffixed ProfileIdentityBar mount and no retired mobile branch", () => {
    expect("surface = {'mobile'}").toMatch(RETIRED_MOBILE_IDENTITY_TOLERANT);
    expect("search - mobile").toMatch(RETIRED_MOBILE_IDENTITY_TOLERANT);
    const offenders = FILES.filter(
      (file) =>
        RETIRED_MOBILE_IDENTITY_LITERAL.test(file.text) ||
        RETIRED_MOBILE_IDENTITY_TOLERANT.test(withoutComments(file.text))
    ).map((file) => file.rel);
    const mounts = FILES.flatMap((file) => {
      const source = withoutComments(file.text);
      return [...source.matchAll(/<ProfileIdentityBar\b/g)].map((match) => ({
        rel: file.rel,
        tag: openingTag(source, match.index),
      }));
    });
    expect(offenders).toEqual([]);
    expect(mounts.map((mount) => mount.rel)).toEqual([
      "components/SidebarContent.tsx",
    ]);
    expect(mounts.some((mount) => /\bsurface\s*=/.test(mount.tag))).toBe(false);
  });

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

  it("classifies every full-viewport overlay, portalled or not", () => {
    const unclassified = FILES.filter(
      (f) =>
        isFullViewportOverlay(f.text) &&
        !OVERLAY_SURFACES.has(f.rel) &&
        !OTHER_FULL_VIEWPORT_OVERLAYS.has(f.rel)
    ).map((f) => f.rel);
    expect(
      unclassified,
      "A new full-viewport portal overlay has to declare which system it is in. " +
        "If it is a bottom/edge-anchored panel, import components/overlay and add " +
        "it to OVERLAY_SURFACES with the outcome its swipe resolves to. If it is a " +
        "centred dialog or popover (different anatomy — #1469 scopes those out), " +
        "add it to OTHER_FULL_VIEWPORT_OVERLAYS with a one-line justification. The " +
        "reasoning for the split is docs/internals/overlays.md."
    ).toEqual([]);
  });

  it("no overlay surface hand-rolls a slide", () => {
    const offenders: string[] = [];
    for (const rel of OVERLAY_SURFACES.keys()) {
      const text = byPath.get(rel) ?? "";
      withoutComments(text)
        .split("\n")
        .forEach((code, i) => {
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
      if (!/["'`]overlay-(?:enter|exit)-/.test(text)) continue;
      withoutComments(text)
        .split("\n")
        .forEach((code, i) => {
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

  // A RECOGNIZER IS A RECOGNIZER WHETHER IT IS ATTACHED IMPERATIVELY OR AS A PROP
  // (#2816). This matched only `addEventListener("pointermove")` until #3958, and React
  // components overwhelmingly attach `onPointerMove={…}` instead — so the one guard
  // that forces "classify or justify" on a new drag recognizer was blind to the
  // spelling this repo actually reaches for. TimelineScrubber landed a whole second
  // recognizer through the hole with CI green; ImageCropper has the same JSX shape and
  // was exempt only because somebody listed it by hand. Both spellings now count.
  const RAW_DRAG_PATTERNS = [
    /addEventListener\(\s*["'](?:pointermove|touchmove)["']/,
    /\bon(?:PointerMove|TouchMove)\s*=/,
  ];

  it("only the shared recognizer reads a raw drag pointer stream", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (RAW_DRAG_LISTENER_ALLOW.has(rel)) continue;
      if (!RAW_DRAG_PATTERNS.some((pattern) => pattern.test(text))) continue;
      withoutComments(text)
        .split("\n")
        .forEach((code, i) => {
          if (RAW_DRAG_PATTERNS.some((pattern) => pattern.test(code))) {
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

  // PROVE THE PATTERN CAN SEE (#2816). A green sweep over a complying tree says nothing
  // about what the sweep can see, and the JSX half was invisible for months while the
  // imperative half passed. Both spellings are fed through here, and the benign
  // neighbours that must stay quiet are fed through with them — a guard that fired on
  // `onPointerDown` or on the word "pointermove" in prose would be deleted within a
  // week, taking the real guard with it.
  it("the raw-drag pattern sees both spellings and neither neighbour", () => {
    const seen = (line: string) =>
      RAW_DRAG_PATTERNS.some((pattern) => pattern.test(line));
    expect(seen('el.addEventListener("pointermove", onMove);')).toBe(true);
    expect(seen('window.addEventListener("touchmove", onMove);')).toBe(true);
    expect(seen("onPointerMove={(event) => track(event.clientY)}")).toBe(true);
    expect(seen("onTouchMove={handleMove}")).toBe(true);
    // Neighbours: a down/up handler is not a stream, and a mention is not a call.
    expect(seen("onPointerDown={(event) => start(event)}")).toBe(false);
    expect(seen("onPointerUp={endDrag}")).toBe(false);
    expect(seen('const name = "pointermove";')).toBe(false);
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
      if (!isFullViewportOverlay(text)) continue;
      for (const line of uncontainedScrollerLines(text))
        offenders.push(`${rel}:${line}`);
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

  it("a full-viewport dialog that hosts a form uses the converged host", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (!isFullViewportOverlay(text)) continue;
      if (OVERLAY_SURFACES.has(rel)) continue;
      if (RAW_FORM_PORTAL_ALLOW.has(rel)) continue;
      if (!hostsRawForm(text)) continue;
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
      if (!/presentation=\{?["']centered["']/.test(text)) continue;
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

  // RULE 8: A DISMISSAL CONTROL DOES NOT LIE (#3405 review).
  //
  // The host draws a real ✕ whenever `showClose` is on, and every ModalShell
  // consumer gets one. A consumer that wants to REFUSE dismissal for a moment —
  // a write already in flight, which closing would not cancel — reaches for the
  // cheapest thing that expresses it, which is a `onClose` that does nothing. The
  // behaviour is then right and the SURFACE LIES: the ✕ still looks live, still
  // takes the tap, and nothing happens, two pixels from a Cancel button that is
  // honestly `disabled`.
  //
  // This is not hypothetical and it is not somebody else's mistake. #3405's own
  // convergence of components/MergeConflictDialog.tsx introduced exactly this, and
  // it survived until review: `onClose={busy ? noop : onCancel}`. The answer is
  // `closeDisabled`, which greys the control out and leaves Escape and the
  // gestures on the consumer's own guard — an ORNAMENT moving is not a reason to
  // widen the host's API, an AFFORDANCE LYING is.
  //
  // MATCHED ON THE SPELLINGS A PERSON REACHES FOR, not on an imagined one: an
  // inline empty arrow, an arrow returning undefined, and a binding NAMED `noop`
  // (the one this lane itself wrote). A guard cannot decide in general whether a
  // named handler is empty; these three are what the shortcut looks like when
  // somebody takes it.
  it("no dialog hands the host a no-op onClose", () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (rel === "components/ModalShell.tsx") continue;
      for (const line of noOpCloseLines(text)) offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      "This surface passes the dialog host an `onClose` that does nothing, so the " +
        "✕ the host draws takes the tap and ignores it — an affordance lying about " +
        "what it will do. If the surface must refuse dismissal for a moment (a " +
        "write already in flight), pass `closeDisabled` and let the control say so, " +
        "the way a `disabled` Cancel beside it already does. `closeDisabled` " +
        "affects the CONTROL only: Escape and the gestures still reach your own " +
        "handler, where the refusal belongs."
    ).toEqual([]);
  });

  it("the no-op scan can see each spelling, and stays silent on a real handler", () => {
    // The three shortcuts.
    expect(
      noOpCloseLines(
        `<ModalShell title="x" onClose={() => {}}>body</ModalShell>`
      )
    ).toHaveLength(1);
    expect(
      noOpCloseLines(
        `<BottomSheet open onClose={() => undefined}>body</BottomSheet>`
      )
    ).toHaveLength(1);
    // The exact shape this lane shipped into review, `noop` and all.
    expect(
      noOpCloseLines(`function noop() {}
         export default function D({ busy, onCancel }) {
           return <ModalShell title="x" onClose={busy ? noop : onCancel}>body</ModalShell>;
         }`)
    ).toHaveLength(1);
    // A handler split across lines, so the tag reader is doing the work rather
    // than a single-line regex.
    expect(
      noOpCloseLines(`<ModalShell
           title="x"
           onKeyDown={(e) => {
             if (e.key === "Escape") stop();
           }}
           onClose={() => {}}
         >body</ModalShell>`)
    ).toHaveLength(1);

    // SILENCE ON THE BENIGN NEIGHBOURS. A real handler, a guarded one, prose
    // describing the shortcut, and an empty arrow on a prop that is NOT onClose —
    // an `onDone` no-op is somebody else's question and this guard must not
    // colonise it.
    expect(
      noOpCloseLines(`<ModalShell onClose={onCancel}>b</ModalShell>`)
    ).toEqual([]);
    // The FIX, in full: a guarded handler that really does something on one
    // branch, plus the prop that greys the control out on the other. This is the
    // shape the rule steers people toward, so it has to stay silent.
    expect(
      noOpCloseLines(`export default function D({ busy, onCancel }) {
           const close = () => {
             if (!busy) onCancel();
           };
           return <ModalShell onClose={close} closeDisabled={busy}>b</ModalShell>;
         }`)
    ).toEqual([]);
    expect(
      noOpCloseLines(
        `<ModalShell onClose={() => setOpen(false)}>b</ModalShell>`
      )
    ).toEqual([]);
    expect(
      noOpCloseLines(`// It used to read \`onClose={() => {}}\` while busy.`)
    ).toEqual([]);
    expect(noOpCloseLines(`<Thing onDone={() => {}} />`)).toEqual([]);
    // And the live consumer that provoked the rule now passes it.
    expect(
      noOpCloseLines(byPath.get("components/MergeConflictDialog.tsx") ?? "")
    ).toEqual([]);
  });

  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN
  // SEE — and this scan's reach is exactly what #3405 changed, so it is the
  // reach that has to be demonstrated rather than asserted. Every fixture below
  // is authored to BREAK a rule in a spelling the repo actually uses, and the
  // silence fixtures beside them are the other half: a widened guard that cried
  // wolf on a click-catcher or on a paragraph would be reverted within a week,
  // taking the widening with it.
  it("the full-viewport scan sees a surface that never portals", () => {
    // THE FOUR THIS USED TO MISS, in one line. The old predicate was
    // `createPortal && fixed inset-0`, so an inline surface answered NO to the
    // first half and left the scan entirely.
    const inlineSurface = `
      export default function InlineTakeover() {
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40">
            <div role="dialog" aria-modal="true" className="max-h-[85vh] overflow-y-auto">
              <form onSubmit={submit}>…</form>
            </div>
          </div>
        );
      }`;
    expect(isFullViewportOverlay(inlineSurface)).toBe(true);
    // …and both rule-5 scans then reach it. This IS app/(app)/training/
    // FitnessCheckView.tsx as it stood before #3405: an uncontained scroller
    // (the #3421 defect) inside a hand-rolled dialog hosting a form. It shipped
    // through three sweeps of its own family because the line above said false.
    expect(uncontainedScrollerLines(inlineSurface)).toHaveLength(1);
    expect(hostsRawForm(inlineSurface)).toBe(true);
  });

  it("the full-viewport scan still sees a portalled surface", () => {
    // The half that already worked keeps working — a widening that quietly
    // narrowed somewhere else would otherwise pass every test above.
    const portalled = `
      import { createPortal } from "react-dom";
      export default function Portalled() {
        return createPortal(
          <div className="fixed inset-0 z-60 overflow-y-auto" role="dialog" />,
          document.body
        );
      }`;
    expect(isFullViewportOverlay(portalled)).toBe(true);
    expect(uncontainedScrollerLines(portalled)).toHaveLength(1);
  });

  it("stays silent on a file that only NAMES the class string in prose", () => {
    // THE FAILURE THE WIDENING WOULD OTHERWISE HAVE INTRODUCED, and it is not
    // hypothetical: components/ModalShell.tsx's history note quotes the exact
    // class string it stopped rendering, and components/OverflowMenu.tsx
    // describes its catcher the same way. With the `createPortal` half gone,
    // nothing but the comment stripper keeps the HOST itself out of a list of
    // unclassified overlays — a guard reading the paragraph that explains why it
    // is not one.
    const lineComment = `
      // It rendered its own portal and its own \`fixed inset-0
      // overflow-y-auto\` scroller, so the app had two implementations.
      export default function Wrapper() {
        return <BottomSheet presentation="dialog">{children}</BottomSheet>;
      }`;
    const blockComment = `
      /* The menu closes on an outside click through a \`fixed inset-0\`
         catcher, and it survives underneath. */
      export default function Menu() {
        return <div className="relative">…</div>;
      }`;
    expect(isFullViewportOverlay(lineComment)).toBe(false);
    expect(isFullViewportOverlay(blockComment)).toBe(false);
    expect(uncontainedScrollerLines(lineComment)).toEqual([]);
    // And the live instances in the tree stay unreported, which is the claim
    // that actually matters — a fixture proves the mechanism, the file proves
    // the outcome.
    expect(
      isFullViewportOverlay(byPath.get("components/ModalShell.tsx") ?? "")
    ).toBe(false);
    expect(
      isFullViewportOverlay(byPath.get("components/OverflowMenu.tsx") ?? "")
    ).toBe(false);
  });

  it("stays silent on an ordinary page, and on a positioned box that is not full-viewport", () => {
    // The benign neighbours. `fixed` alone is a toast, a sticky bar, a FAB;
    // `inset-0` alone is an absolutely-positioned fill inside a card. Neither is
    // an overlay, and there are hundreds of them.
    expect(
      isFullViewportOverlay(`<div className="fixed bottom-4 right-4" />`)
    ).toBe(false);
    expect(
      isFullViewportOverlay(`<div className="absolute inset-0 bg-black/40" />`)
    ).toBe(false);
    expect(
      isFullViewportOverlay(`<div className="sticky top-0 z-10 bg-surface" />`)
    ).toBe(false);
  });

  it("the scroller scan reads the ELEMENT, not the file", () => {
    // Two scrollers, one contained: the file mentions `overscroll-contain`, and
    // the uncontained one still chains. "Does this file contain the string" is
    // the cheaper question, and it answers green here.
    const twoScrollers = `
      <div className="fixed inset-0">
        <div className="overflow-y-auto overscroll-contain">a</div>
        <div className="overflow-y-auto">b</div>
      </div>`;
    expect(uncontainedScrollerLines(twoScrollers)).toEqual([4]);
  });

  it("keeps the allowlists honest", () => {
    const stale: string[] = [];
    for (const rel of OTHER_FULL_VIEWPORT_OVERLAYS.keys()) {
      const text = byPath.get(rel);
      if (text == null) stale.push(`${rel} (gone from disk)`);
      else if (!isFullViewportOverlay(text))
        stale.push(`${rel} (no longer a full-viewport overlay)`);
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
      else if (!hostsRawForm(text))
        stale.push(`${rel} (no longer hosts a form)`);
    }
    for (const [, why] of [
      ...OVERLAY_SURFACES,
      ...OTHER_FULL_VIEWPORT_OVERLAYS,
    ]) {
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
