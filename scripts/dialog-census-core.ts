// The dialog census (#3405).
//
// THE QUESTION THIS ANSWERS, stated so the next reader can check that the code
// below asks it and not a cheaper one:
//
//     For every component that puts a modal dialog surface on screen, WHICH
//     HOST does it render through — and which render through none?
//
// THE QUESTION IT REPLACES, and why that one was wrong. Three sweeps of this
// family (#3388, #3401, #3404) enumerated dialogs with a file-level
// `grep -l 'ModalShell|BottomSheet'`. That grep answers "does this FILE mention
// the string", which is not the same question, and it is wrong in BOTH
// directions at once:
//
//   * It OVER-matches. components/MergeConflictDialog.tsx landed in the
//     `ModalShell` results only because a COMMENT in it says the word. A sweep
//     nearly published that as a count in a doc whose whole value is being
//     checkable.
//   * It UNDER-matches. A dialog that hand-rolls its own surface never mentions
//     either host, so it is invisible — which is how a whole component stayed
//     unexamined through three passes over its own family.
//
// So membership here is matched on the IMPORT and on the JSX, never on the
// filename and never on a bare mention. Comments are stripped before any
// classification runs, which is precisely what drops the over-match; and a
// self-declared dialog is found by what it RENDERS, which is what catches the
// under-match.
//
// WHY THIS LIVES IN scripts/ AND NOT lib/. It is a build-time source ANALYSER,
// not app logic — nothing here ever runs in the app. It also cannot live under
// lib/: this file necessarily NAMES the constructs it censuses, and
// lib/__tests__/overlay-motion-chokepoint.test.ts classifies any scanned file
// containing both `createPortal` and the full-viewport class string as an
// unclassified overlay. It reported this module as one. That guard is matching on
// a MENTION — the same cheaper question #3405 is about — but widening it to buy
// this module a home would be the wrong trade, and the placement it forced is the
// better one: analysers sit beside the other build-time tooling
// (scripts/orchestration/reconcile-tracker-core.ts is the same split, a core
// module with its CLI beside it), and lib/__tests__ imports them from there the
// way the gen-* dataset tests already do.
//
// A NOTE ON READING FILES DIRECTLY. This walks the tree with node:fs rather
// than shelling out to a grep. That is not a style preference: several source
// files in this repo carry a deliberate NUL byte as a composite-key separator
// (lib/__tests__/nul-byte-census.test.ts, #3206), and ripgrep calls those files
// BINARY and skips them unless asked otherwise — reporting a sweep it never
// took. fs.readFileSync has no such notion, so a census built on it cannot
// quietly skip a file. There is a test that proves this rather than trusting it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsParsed } from "./source-comment-ranges";

export const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

const SCAN_DIRS = ["app", "components", "lib"];

// ── The hosts ────────────────────────────────────────────────────────────────
// The converged dialog host, as it actually exists after #2774: BottomSheet is
// the one primitive, and the other two are wrappers over it. A file "belongs to
// a host" when it imports one of these modules AND uses what it imported.
export const HOST_MODULES: Record<string, string> = {
  "components/BottomSheet.tsx":
    "the primitive — a sheet below `md`, a centred card above (#2774)",
  "components/ModalShell.tsx":
    'the responsive dialog — a thin wrapper over BottomSheet\'s `presentation="dialog"`',
  "components/ConfirmDialog.tsx":
    "the shared confirm — ONE instance mounted by ConfirmProvider, reached through a hook",
};

// THE SPELLING THE REPO ACTUALLY USES, which is not the one the issue implies.
// #3405 describes the family as dialogs that do or do not render a host, and it
// is tempting to encode "renders `<ConfirmDialog>`". Nothing in this repo writes
// that. ConfirmDialog is consumed as a HOOK — `useConfirm`, `useOptionalConfirm`,
// `useConfirmOpen` — over a single provider-mounted surface, across ~49 call
// sites. A census that looked for the element would have been green against a
// tree that has never used it, which is worse than no census: it turns "nobody
// does this" into "nobody can do this", and only the first is true.
//
// So the rule is one rule, and it covers both spellings: the imported BINDING
// must appear in the file body outside its own import statement. Whether that
// binding is an element or a hook is then a fact we REPORT, not a fact we had
// to guess in advance.
const CONFIRM_HOOKS = ["useConfirm", "useOptionalConfirm", "useConfirmOpen"];

// ── The register of dialogs belonging to NO DIALOG HOST ──────────────────────
//
// "No host" here means no DIALOG host — none of HOST_MODULES above.
//
// THE OWNER RULED ON THIS REGISTER (#3405, 2026-08-20), and the ruling is what
// each entry now records instead of "status undecided":
//
//   CONVERGENCE IS THE DEFAULT. A dialog belongs on the shared host unless
//   docs/internals/overlays.md names it an exception with a stated reason.
//   Naming every hostless dialog as sanctioned was declined in as many words —
//   "nine exceptions to a rule with about a dozen followers is not a convention".
//
// Three of the nine this register was written with have since converged and are
// gone from it (MergeConflictDialog, PlateBuilderModal, FitnessCheckView). What
// is left is the recorded exceptions, plus ONE entry that is not an exception at
// all — see `scopedOut`.
//
// READ THIS BEFORE ADDING AN ENTRY. An entry is not a place to park a surface
// you did not want to converge. It states the ANATOMY reason the shared host
// cannot serve it, the same reason appears in docs/internals/overlays.md, and
// lib/__tests__/dialog-census.test.ts checks that the two agree — a register the
// doc does not know about, or a doc row whose subject has converged, both fail.
//
// The guard over this register fails on a hostless dialog that is NOT recorded,
// and on a record that has outlived its subject. It deliberately does NOT fail on
// the recorded set: these are sanctioned, and a build error on a sanctioned
// exception teaches the next reader to delete the register.
//
// No count is written in this file's prose ON PURPOSE, and it is not squeamishness:
// this comment said SEVEN while the register below held NINE, having gone stale the
// moment two entries were added. A hand-maintained number drifting from the thing it
// counts is the exact failure #3405 exists to end, and it had reproduced itself
// inside the file whose whole subject is a count that was wrong three times. A
// reader who checks a number against the register and finds a discrepancy has no way
// to know which side is right. Where a count is genuinely useful, DERIVE it — the
// guard's failure message reads Object.keys(HOSTLESS_DIALOGS).length — and where it
// is only rhetorical, say "every entry".
export interface HostlessRecord {
  /** The ANATOMY reason the shared dialog host cannot serve this surface. */
  why: string;
  /**
   * True when the file is not a member of the dialog family AT ALL.
   *
   * `MobileDetailPage` is the case the owner ruled on: a full-page mobile
   * takeover is not a centred dialog, so it leaves the family by ANATOMY rather
   * than by exemption — "the census and the guard should say so, rather than
   * recording it as an exception to a rule it was never an instance of". It stays
   * in this register because a sweep that quietly drops what it has decided is
   * fine is the sweep that lost MergeConflictDialog for three passes; it is
   * PRINTED and TESTED separately because calling it an exception would hand the
   * next hand-rolled dialog a precedent it has not earned.
   */
  scopedOut?: boolean;
}

export const HOSTLESS_DIALOGS: Record<string, HostlessRecord> = {
  "components/ImageCropper.tsx": {
    why: "RECORDED EXCEPTION. It opens OVER an already-open ModalShell (both profile-photo pickers are dialogs), so it needs `z-120` — above the sheet's `z-60` and above the toasts' `z-100` — and the host exposes no stacking prop. Its pointer drag also manipulates CONTENT across the whole panel (panning the image inside the crop circle), which a sheet's swipe-down dismissal would arbitrate against; #1469 already scopes that gesture out for the same reason.",
  },
  "components/photo/PhotoGallery.tsx": {
    why: "RECORDED EXCEPTION. The lightbox is a full-bleed media viewer — a black ground with the original `object-contain` to the viewport edges and its own prev/next paging — where the host's titled `bg-surface` card with padding and a scroll owner is the wrong shape, and the sheet's swipe-down would arbitrate against the horizontal paging. The exception is presentation only: since #3405 it takes the shared useFocusTrap, so initial focus, the Tab trap, capture-phase Escape and focus restore are the host's after all.",
  },
  "components/activity-form/FitnessTestTimer.tsx": {
    why: "RECORDED EXCEPTION. The host mounts on open and unmounts on close; this takeover MUST survive being closed — collapsing it returns the viewer to the entry sheet with the run still going, and the elapsed state lives in the component. It is also nested inside an already-scrimmed sheet (so it carries no scrim of its own) and its capture-phase Escape stops propagation so collapsing the timer does not also close the sheet underneath.",
  },
  "components/ActivityOverlay.tsx": {
    why: "RECORDED EXCEPTION, and converged — onto components/overlay rather than onto the dialog host. Registered as an OVERLAY_SURFACE in lib/__tests__/overlay-motion-chokepoint.test.ts. The dialog host is transactional (mount to open, unmount to close, swipe-down DISCARDS); a live workout runs for an hour, survives navigation as the minimized bar, and its drag resolves to MINIMIZE (#1469).",
  },
  "components/ProfileIdentityBar.tsx": {
    why: "RECORDED EXCEPTION, and converged onto components/overlay in the same way as ActivityOverlay — shared primitives, focus trap, body lock, contained scroller. Its anatomy is TOP-anchored: the panel drops out of the identity bar and a swipe UP retreats through it, which a centred host has no anchor to express (#1801).",
  },
  "components/MobileNav.tsx": {
    // RECORDED RATHER THAN SCOPED OUT, and the argument against is worth
    // keeping. docs/internals/overlays.md's host table routes MENU or NAVIGATION
    // to this drawer rather than to the dialog host, which reads as "it is a
    // host, not an exception" — the MobileDetailPage argument. It loses, and on
    // a distinction rather than a preference: that table describes what the
    // drawer HOSTS, not what the drawer IS, and both are true at once. It is the
    // surface menus live on, AND it is itself a hand-rolled scrimmed modal.
    // MobileDetailPage is scoped out because it FAILS the anatomy test — it
    // replaces the page and carries no scrim; the drawer fails neither, and its
    // nearest neighbour here is ProfileIdentityBar, an anchored non-transactional
    // panel that floats over the page with a scrim and converged onto
    // components/overlay. (Owner ruling, #3445.)
    why: "RECORDED EXCEPTION, and converged — onto components/overlay, the same way ActivityOverlay and ProfileIdentityBar are. Its anatomy is EDGE-anchored: the drawer travels in from the left screen edge and an edge swipe both opens it and retreats through it (useDragGesture/useOverlayDrag, #1416/#2746), which a centred card has no edge to travel from. Found by ANATOMY rather than by ARIA (#3445) — it carries no role and no aria-modal, which is a real gap and a separate question from where it renders.",
  },
  "components/MobileDetailPage.tsx": {
    scopedOut: true,
    why: "NOT A DIALOG. A full-page mobile takeover for master/detail: it replaces the page rather than floating over it, carries no scrim, and is dismissed by the back gesture (useHistoryBackClose) the way a page is. Scoped OUT of the dialog family by anatomy (owner ruling on #3405), not excepted from it.",
  },
};

// ── Source reading ───────────────────────────────────────────────────────────

export interface SourceFile {
  rel: string;
  text: string;
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

export function readSourceFiles(root: string = REPO_ROOT): SourceFile[] {
  const files: SourceFile[] = [];
  for (const dir of SCAN_DIRS) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const full of walk(base)) {
      const rel = path.relative(root, full).split(path.sep).join("/");
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

/**
 * The file with every comment blanked out but its LINE NUMBERS and its string
 * literals intact.
 *
 * Blanking comments is the whole defence against the over-match: it is what
 * makes a file that merely NAMES `ModalShell` in prose stop counting as a
 * consumer of it.
 *
 * Strings, templates and regular-expression literals are copied through verbatim,
 * comment openers and all. Both halves are load-bearing: `accept="image/*"` and
 * `/\/*$/` must not open phantom block comments that blank everything after them.
 * This census uses the parser-backed path because its failure direction is
 * security-guard-shaped: deleting source can hide a dialog. A raw scanner cannot
 * distinguish division from a regex after `)` or `}`, so `/[/*]/` in either position
 * can otherwise open a phantom block comment and blank a later ModalShell (#3532).
 * Invalid source stops the census with its file and parse location: raw comments may
 * not authenticate a host, and malformed code may not silently disappear.
 */
export function withoutComments(text: string, rel = "source.tsx"): string {
  return stripCommentsParsed(rel, text);
}

// ── Imports ──────────────────────────────────────────────────────────────────

export interface ImportedBinding {
  /** Repo-relative module path with no extension, e.g. "components/ModalShell". */
  module: string;
  /** The local name the importing file bound it to. */
  local: string;
  /** True when it arrived as the module's default export. */
  isDefault: boolean;
  /**
   * True for `import type {…}` and for an inline `{ type X }`.
   *
   * A TYPE import is never a use of the host as a surface, and saying so is not
   * hair-splitting: components/useConfirmedAction.ts imports the type
   * `ConfirmOptions` beside the `useConfirm` hook, and without this flag the
   * census counted it as a component rendering a dialog. It renders nothing.
   */
  isType: boolean;
}

const IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;

/**
 * Resolve an import specifier to a repo-relative path without an extension.
 *
 * A bare package name is returned UNCHANGED rather than discarded. Dropping
 * them was this module's own first bug: `createPortal` arrives from the
 * `"react-dom"` package, so a resolver that only kept repo-local paths reported
 * every single dialog as portal-free — a census quietly answering "no" to a
 * question it had thrown the evidence away for. Bare names cannot collide with
 * the repo-local host paths below, which all end in `.tsx`.
 */
export function resolveSpecifier(fromRel: string, spec: string): string {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith(".")) {
    const dir = path.posix.dirname(fromRel);
    return path.posix.normalize(path.posix.join(dir, spec));
  }
  return spec;
}

/**
 * Every binding this file imports from a repo-local module.
 *
 * Matched on the module PATH and the local BINDING NAME rather than on the
 * symbol's spelling at the call site, so a renamed default (`import Shell from
 * "@/components/ModalShell"`) is still recognised as the host it is.
 */
export function importedBindings(file: SourceFile): ImportedBinding[] {
  const code = withoutComments(file.text, file.rel);
  const out: ImportedBinding[] = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    const wholeClauseIsType = m[1] != null;
    const clause = m[2];
    // Named `moduleId`, not `module`: Next's no-assign-module-variable lint rule
    // reserves the bare name.
    const moduleId = resolveSpecifier(file.rel, m[3]);
    // `Default, { a, b as c }` — split the default half from the named half.
    const braceAt = clause.indexOf("{");
    const defaultPart = (braceAt === -1 ? clause : clause.slice(0, braceAt))
      .replace(/,\s*$/, "")
      .trim();
    if (defaultPart && !defaultPart.startsWith("*")) {
      out.push({
        module: moduleId,
        local: defaultPart,
        isDefault: true,
        isType: wholeClauseIsType,
      });
    }
    if (braceAt !== -1) {
      const named = clause.slice(braceAt + 1, clause.lastIndexOf("}"));
      for (const raw of named.split(",")) {
        const inlineType = /\btype\b/.test(raw);
        const piece = raw.replace(/\btype\b/g, "").trim();
        if (!piece) continue;
        const asAt = piece.split(/\s+as\s+/);
        const local = (asAt[1] ?? asAt[0]).trim();
        if (local)
          out.push({
            module: moduleId,
            local,
            isDefault: false,
            isType: wholeClauseIsType || inlineType,
          });
      }
    }
  }
  return out;
}

/**
 * Is this binding actually USED, or merely imported?
 *
 * An import the file never applies is exactly the state a census must not count
 * — it is the import-level form of the same over-match a comment produces. The
 * body is the comment-stripped source with every import statement removed, so a
 * name that appears only in its own import line does not qualify.
 */
function bindingIsUsed(code: string, local: string): boolean {
  const body = code.replace(/import[\s\S]*?from\s*["'][^"']+["'];?/g, "");
  return new RegExp(
    `\\b${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
  ).test(body);
}

// ── Self-declared dialogs ────────────────────────────────────────────────────

// A JSX attribute, not a substring. The leading boundary is what tells the
// attribute apart from a CSS SELECTOR that names the same role: components/
// useFocusTrap.ts asks `target.closest('[role="dialog"]')`, where the character
// before `role` is `[`. Querying for dialogs is not being one, and a census that
// cried wolf on the shared focus trap would be deleted within a week — taking
// the real census with it.
//
// THE ROLE MAY BE COMPUTED. `role={danger ? "alertdialog" : "dialog"}` declares
// an ARIA dialog role at runtime, and the first spelling of this pattern
// required a quote IMMEDIATELY after the optional `{`, so it did not match
// (#3445). The braces group cannot cross a `}`, which keeps `role={role}`
// followed by an unrelated `"dialog"` string later in the file from matching.
const DIALOG_ROLE_RE = /(^|[\s{])role=(\{[^}]*?)?["'](dialog|alertdialog)["']/m;
const ARIA_MODAL_RE = /(^|[\s{])aria-modal[=\s]/m;
// The native element whose entire purpose is to be a dialog. `</dialog>` cannot
// match — the character after `<` is `/` — and neither can `<dialogue>`.
const NATIVE_DIALOG_RE = /<dialog[\s>/]/m;

/**
 * Does this file DECLARE a dialog, in the accessibility tree?
 *
 * This is the ARIA half of the question and it is deliberately narrow: what a
 * screen reader would be told. It is NOT the whole of "hand-rolls a dialog
 * surface" — see `declaresModalAnatomy` for the half that has no ARIA at all.
 */
export function declaresOwnDialog(code: string): boolean {
  return (
    DIALOG_ROLE_RE.test(code) ||
    ARIA_MODAL_RE.test(code) ||
    NATIVE_DIALOG_RE.test(code)
  );
}

// ── Reading a JSX opening tag ────────────────────────────────────────────────
//
// Needed because "is there an `onClick` near a `fixed inset-0`" is a question
// about ONE ELEMENT, and a line-level or file-level answer is wrong in both
// directions: prettier breaks a long className onto its own line (so the line
// answer misses), and any file with a scrim somewhere and a button somewhere
// would pass a file answer (so the file answer over-matches).

function skipStringFrom(code: string, i: number): number {
  const quote = code[i];
  i += 1;
  while (i < code.length && code[i] !== quote) {
    if (code[i] === "\\") i += 2;
    else i += 1;
  }
  return i + 1;
}

/**
 * Every JSX opening tag in `code` whose text matches `inner`, returned as the
 * tag source from `<` through its closing `>`.
 *
 * Brace depth is tracked so an expression attribute containing a `>` (an arrow
 * function, a comparison) does not end the tag early, and strings are skipped so
 * a `>` inside a class string does not either.
 */
export function openingTagsMatching(code: string, inner: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== "<") continue;
    // `<` FOLLOWED BY A LETTER is a heuristic, and it deliberately does not try
    // to be a parser: a type parameter (`Map<string, string>`) and a tight
    // comparison (`i<n`) both open a "tag" here. That costs nothing, because the
    // slice is only ever consulted through `inner` — a run of source that is not
    // a tag will not carry `fixed inset-0` AND an `onClick` on the same element.
    // The failure to avoid is the opposite one, ending a real tag early, which
    // is what the brace depth and the string skipping below are for.
    if (!/[A-Za-z]/.test(code[i + 1] ?? "")) continue;
    const start = i;
    let j = i + 1;
    let depth = 0;
    while (j < code.length) {
      const ch = code[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        j = skipStringFrom(code, j);
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
      j += 1;
    }
    const tag = code.slice(start, Math.min(j + 1, code.length));
    if (inner.test(tag)) out.push(tag);
  }
  return out;
}

// The scrim, in the two spellings this repo actually uses: the shared token
// (components/overlay/tokens.ts) and the literal tint it expands to. Matched
// because a DIALOG dims the page under it while a menu's click-catcher is
// transparent — components/CompactDateMenu.tsx renders `fixed inset-0 z-20`
// with nothing drawn on it.
const SCRIM_RE = /OVERLAY_SCRIM|\bbg-(?:black|slate-900|slate-950)\/\d/;
const FULL_VIEWPORT_RE = /\bfixed inset-0\b/;
const CLOSE_CONTROL_RE = /aria-label=\{?["']Close/;

// ── What a hostless dialog hand-rolls ────────────────────────────────────────

export interface HandRolled {
  /** Portals itself out of the tree — matched on the react-dom IMPORT. */
  portal: boolean;
  /** Uses the shared focus trap rather than its own focus behaviour. */
  sharedFocusTrap: boolean;
  /** Uses the shared body-scroll lock (which is reference-counted, #2774). */
  sharedBodyLock: boolean;
  /** Consumes the shared overlay motion/gesture primitives (#1469). */
  sharedOverlayPrimitives: boolean;
  /** Handles the Escape key itself. */
  ownEscapeHandler: boolean;
  /** Owns a scroller. */
  ownScroller: boolean;
  /** …and, if it does, whether every one of them contains its overscroll. */
  overscrollContained: boolean;
  /** Covers the viewport with its own `fixed inset-0`. */
  ownFullViewportLayer: boolean;
  /**
   * Dims the page beneath it — the shared `OVERLAY_SCRIM` token or the literal
   * tint it expands to.
   *
   * REPORTED SEPARATELY FROM `ownFullViewportLayer` because that is where the
   * dialogs and the menus part company: components/CompactDateMenu.tsx also
   * covers the viewport, with a transparent click-catcher that draws nothing.
   */
  scrim: boolean;
  /**
   * Offers a dismissal of its own: Escape, a click on its scrim or its
   * full-viewport layer, or a labelled Close control.
   *
   * A full-viewport layer with NO dismissal is a blocking curtain (a splash, a
   * route transition, a saving guard), not a dialog. This is the clause that
   * keeps `declaresModalAnatomy` from calling one of those a dialog.
   *
   * IT EXCLUDES NOTHING IN THIS TREE TODAY, and you should know that before you
   * decide about it. Every file that covers the viewport and either portals or
   * locks the body is dismissible — there is no blocking curtain in app/,
   * components/ or lib/. So this clause is a NARROWING against a shape that has
   * not appeared yet, its cost today is zero, and its only killer in
   * lib/__tests__/dialog-census.test.ts is a SYNTHETIC fixture rather than a
   * real file. Every other clause here is killed by something somebody else
   * wrote. Written down rather than resolved away: a reader who later deletes
   * this deserves to know it was never load-bearing, instead of discovering it.
   */
  dismissible: boolean;
}

export function handRolled(
  file: SourceFile,
  bindings: ImportedBinding[]
): HandRolled {
  const code = withoutComments(file.text, file.rel);
  const imports = (module: string, local?: string) =>
    bindings.some(
      (b) => b.module === module && (local == null || b.local === local)
    );
  const scrollerLines = code
    .split("\n")
    .filter((line) => /\boverflow-y-auto\b/.test(line));
  const ownEscape = /["'`]Escape["'`]/.test(code);
  return {
    // MATCHED ON THE IMPORT, and this is not pedantry: lib/portals.ts exports a
    // completely unrelated `createPortal` for the patient-portals domain, and a
    // bare name grep for it returns well over a hundred lines of medical-records
    // code. The react-dom import is what makes the question the right one.
    portal: bindings.some(
      (b) => b.module === "react-dom" && b.local === "createPortal"
    ),
    sharedFocusTrap: imports("components/useFocusTrap"),
    sharedBodyLock: imports("components/useLockBodyScroll"),
    sharedOverlayPrimitives: bindings.some((b) =>
      b.module.startsWith("components/overlay")
    ),
    ownEscapeHandler: ownEscape,
    ownScroller: scrollerLines.length > 0,
    overscrollContained:
      scrollerLines.length > 0 &&
      scrollerLines.every((line) => /\boverscroll-contain\b/.test(line)),
    ownFullViewportLayer: FULL_VIEWPORT_RE.test(code),
    scrim: SCRIM_RE.test(code),
    // MATCHED ON THE ELEMENT, not on the file. `openingTagsMatching` returns the
    // one tag that carries the layer or the scrim, and the question is whether
    // THAT tag takes the click — a file-level `onClick` grep would pass on any
    // component that has a button in it, which is all of them.
    dismissible:
      ownEscape ||
      CLOSE_CONTROL_RE.test(code) ||
      openingTagsMatching(code, FULL_VIEWPORT_RE).some((tag) =>
        /\bonClick=/.test(tag)
      ) ||
      openingTagsMatching(code, SCRIM_RE).some((tag) => /\bonClick=/.test(tag)),
  };
}

/**
 * Does this file hand-roll a MODAL SURFACE, judged by its anatomy alone?
 *
 * THIS IS THE HALF `declaresOwnDialog` CANNOT SEE, and #3445 is the receipt: the
 * detector asked only whether a file spelled `role="dialog"` / `aria-modal`, so
 * "hand-rolls a dialog surface" had quietly become "hand-rolls a dialog surface
 * AND remembered the ARIA" — the weaker claim reading as the stronger one. The
 * modal most in need of being found is exactly the one that forgot, because it is
 * inaccessible as well as unhosted.
 *
 * THE THREE CLAUSES, and what each one is holding out:
 *
 *   1. It covers the viewport with a layer of its own. A panel anchored to its
 *      trigger is a popover; this one owns the screen.
 *   2. It leaves its own DOM neighbourhood — it portals, or it locks the body.
 *      A dropdown rendered in place under its button does neither, and neither
 *      does a toast in its own corner. This is what components/CompactDateMenu.tsx
 *      fails: a `fixed inset-0` catcher rendered inline, no portal, no lock.
 *   3. It can be dismissed. Without this a blocking curtain — a splash, a route
 *      transition, an in-flight guard — reads as a dialog.
 *
 * THE BIAS IS THE MODULE'S OWN, stated on `handRolled` and restated by #3445:
 * REPORT and let a human decide, rather than stay silent. A surface that meets
 * all three and is not a dialog is answered by a `scopedOut` record, which costs
 * one entry and leaves the fact visible; a surface that is a dialog and stays
 * silent costs the register its meaning.
 *
 * AND THAT BIAS IS ONLY AFFORDABLE AT A VOLUME A HUMAN ACTUALLY READS. A rule
 * that reported thirty files would end the register as surely as silence does,
 * from the other side. So it was MEASURED before it was adopted, over the tree at
 * 6de40080: this route classifies exactly TWO files that the ARIA-only detector
 * could not see — components/LevelBadge.tsx (which converged, and is a ModalShell
 * consumer now) and components/MobileNav.tsx (recorded above). It declines three
 * near-misses that carry a portal or a full-viewport layer and are not dialogs:
 * components/CompactDateMenu.tsx, components/Combobox.tsx and
 * components/InfoTooltipIcon.tsx. Those five files are asserted BY NAME in
 * lib/__tests__/dialog-census.test.ts, on the real source rather than on a
 * fixture, because a rule proven only against fixtures written from its own
 * premise is the defect #3445 filed.
 */
export function declaresModalAnatomy(h: HandRolled): boolean {
  return (
    h.ownFullViewportLayer && (h.portal || h.sharedBodyLock) && h.dismissible
  );
}

// ── The census ───────────────────────────────────────────────────────────────

export type DialogKind =
  /** One of the host modules itself. */
  | "host"
  /** Renders a dialog through a host module. */
  | "hosted"
  /** Renders a dialog surface of its own, through no host. */
  | "hostless"
  /** Shows the ONE provider-mounted confirm via its hook, rather than a surface. */
  | "confirm-caller";

export interface DialogEntry {
  rel: string;
  kind: DialogKind;
  /** For "hosted"/"confirm-caller": the host modules whose bindings it uses. */
  hosts: string[];
  /** The binding names it actually uses, e.g. ["ModalShell"] or ["useConfirm"]. */
  via: string[];
  /** For "hostless": what it answers for itself. */
  handRolled?: HandRolled;
  /**
   * For "hostless": WHICH signal classified it.
   *
   * Printed, because the two are different findings. "aria" means the file says
   * it is a dialog and a screen reader is told so; "anatomy" means nothing in it
   * says dialog and it was recognised by what it renders (#3445) — which also
   * means it is unlabelled to assistive technology, a defect on its own.
   */
  declaredBy?: "aria" | "anatomy";
}

export interface DialogCensus {
  filesScanned: number;
  entries: DialogEntry[];
  hosts: DialogEntry[];
  hosted: DialogEntry[];
  /**
   * Every dialog surface belonging to no dialog host, structurally — recorded
   * exceptions AND the scoped-out entry alike. Kept whole so nothing is dropped
   * by a caller that only looks at one of the two lists below.
   */
  hostless: DialogEntry[];
  /**
   * The RECORDED EXCEPTIONS: hostless, and members of the dialog family, so each
   * one is an exception to the convergence rule and answers to it.
   */
  exceptions: DialogEntry[];
  /**
   * SCOPED OUT BY ANATOMY: hostless on disk, but not a member of the dialog
   * family at all, so the convergence rule was never about them (owner ruling on
   * #3405). Reported separately rather than filtered away or miscounted as an
   * exception.
   */
  scopedOut: DialogEntry[];
  confirmCallers: DialogEntry[];
  /** Hostless on disk but absent from HOSTLESS_DIALOGS — the guard's failure. */
  unrecordedHostless: string[];
  /** Recorded in HOSTLESS_DIALOGS but no longer hostless on disk. */
  staleRecords: string[];
}

export function censusDialogs(files: SourceFile[]): DialogCensus {
  const entries: DialogEntry[] = [];
  for (const file of files) {
    const code = withoutComments(file.text, file.rel);
    const bindings = importedBindings(file);

    const hosts: string[] = [];
    const via: string[] = [];
    for (const b of bindings) {
      const hostRel = `${b.module}.tsx`;
      if (!(hostRel in HOST_MODULES)) continue;
      if (b.isType) continue; // a type is not a surface
      if (hostRel === file.rel) continue; // a module does not host itself
      if (!bindingIsUsed(code, b.local)) continue;
      if (!hosts.includes(hostRel)) hosts.push(hostRel);
      if (!via.includes(b.local)) via.push(b.local);
    }

    if (file.rel in HOST_MODULES) {
      entries.push({ rel: file.rel, kind: "host", hosts, via });
      continue;
    }
    // A file whose ONLY host binding is a confirm hook is not rendering a
    // surface — it is asking the one provider-mounted ConfirmDialog to show
    // itself. Reported, and reported as its own kind, so it is neither silently
    // omitted nor confused with a dialog component.
    const rendersHostSurface = via.some((v) => !CONFIRM_HOOKS.includes(v));
    if (hosts.length > 0 && rendersHostSurface) {
      entries.push({ rel: file.rel, kind: "hosted", hosts, via });
      continue;
    }
    // TWO ROUTES INTO "hostless", and the second one is #3445. The first asks
    // what the file DECLARES (role/aria-modal/<dialog>); the second asks what it
    // RENDERS, so a hand-rolled modal carrying no ARIA at all is seen. A census
    // that only had the first was answering "nobody has hand-rolled a dialog
    // WHILE ALSO WRITING role=dialog", which is the weaker claim and read as the
    // stronger one.
    const hr = handRolled(file, bindings);
    const declared = declaresOwnDialog(code);
    if (declared || declaresModalAnatomy(hr)) {
      entries.push({
        rel: file.rel,
        kind: "hostless",
        hosts,
        via,
        handRolled: hr,
        declaredBy: declared ? "aria" : "anatomy",
      });
      continue;
    }
    if (hosts.length > 0) {
      entries.push({ rel: file.rel, kind: "confirm-caller", hosts, via });
    }
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const of = (kind: DialogKind) => entries.filter((e) => e.kind === kind);
  const hostless = of("hostless");
  const hostlessRels = new Set(hostless.map((e) => e.rel));
  return {
    filesScanned: files.length,
    entries,
    hosts: of("host"),
    hosted: of("hosted"),
    hostless,
    exceptions: hostless.filter(
      (e) => HOSTLESS_DIALOGS[e.rel]?.scopedOut !== true
    ),
    scopedOut: hostless.filter(
      (e) => HOSTLESS_DIALOGS[e.rel]?.scopedOut === true
    ),
    confirmCallers: of("confirm-caller"),
    unrecordedHostless: hostless
      .map((e) => e.rel)
      .filter((rel) => !(rel in HOSTLESS_DIALOGS)),
    staleRecords: Object.keys(HOSTLESS_DIALOGS).filter(
      (rel) => !hostlessRels.has(rel)
    ),
  };
}

/** The census over the working tree. */
export function censusRepoDialogs(root: string = REPO_ROOT): DialogCensus {
  return censusDialogs(readSourceFiles(root));
}
