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
// "No host" here means no DIALOG host — none of HOST_MODULES above. Two entries
// below are converged, just onto a different system: components/overlay owns the
// motion, gesture and scrim tokens for the bottom/edge-anchored surfaces (#1469),
// and both are registered as OVERLAY_SURFACES in
// lib/__tests__/overlay-motion-chokepoint.test.ts. They are listed anyway rather
// than filtered out, because a census that quietly drops the cases it has decided
// are fine is the same census that lost MergeConflictDialog for three passes. The
// script prints "shared overlay primitives" against exactly those two, so the
// distinction is visible without being load-bearing.
//
// READ THIS BEFORE ADDING AN ENTRY. This register is a CENSUS, not a set of
// sanctions. Every entry below states, factually, what the component hand-rolls.
// None of them says the arrangement is correct, because that call has not been
// made: #3405 asks whether these converge onto the host or are named in
// docs/internals/overlays.md as sanctioned exceptions, and answers "this is a
// design call about the convergence's boundary, not something a lane should
// decide". Until that is answered, an entry here means ONLY "this was on disk
// and unhosted on the day the census was written".
//
// The guard over this register (lib/__tests__/dialog-census.test.ts) therefore
// fails on a hostless dialog that is NOT recorded, and on a recorded one that is
// no longer hostless. It deliberately does NOT fail on the recorded set itself —
// a build error on every recorded entry would force the owner's open design call
// to be made once per entry by whoever next touched the tree.
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
export const HOSTLESS_DIALOGS: Record<string, string> = {
  "components/MergeConflictDialog.tsx":
    "the #3405 straggler: own portal, own scrim, own z-index, own focus behaviour — and not even the shared useFocusTrap. Its comment says it COPIED ModalShell's behaviour rather than using it. Status undecided (#3405).",
  "components/PlateBuilderModal.tsx":
    "centred tool modal (barbell plate math): own portal and scrim, but does share useFocusTrap. Status undecided (#3405).",
  "components/ImageCropper.tsx":
    "the crop surface: own portal and scrim, no shared focus trap. Its pointer drag manipulates CONTENT, so #1469 already scopes its GESTURE out; that says nothing about its host. Status undecided (#3405).",
  "components/MobileDetailPage.tsx":
    "mobile full-page takeover for master/detail: NO portal at all — inline `fixed inset-0` — with its own Escape handler, its own useLockBodyScroll and its own contained scroller. Status undecided (#3405).",
  "components/photo/PhotoGallery.tsx":
    "the photo lightbox: NO portal, own `fixed inset-0` scrim, and its Escape lives on the panel's own onKeyDown rather than the shared trap. Status undecided (#3405).",
  "components/activity-form/FitnessTestTimer.tsx":
    "the fitness-test timer takeover: NO portal, own `fixed inset-0 z-60`, own Escape handler, no scrim and no focus trap. Status undecided (#3405).",
  "app/(app)/training/FitnessCheckView.tsx":
    "the fitness-check entry panel: NO portal, and it hand-rolls the host's own anatomy — scrim, centred `max-w-lg` card, `max-h-[85vh]` and its own `overflow-y-auto`, which is the one scroller in this list that does NOT contain its overscroll. Status undecided (#3405).",
  "components/ActivityOverlay.tsx":
    "the activity workspace. Converged, but onto components/overlay rather than the dialog host: shared primitives, shared focus trap, shared body lock, contained scroller. Registered as an OVERLAY_SURFACE in the chokepoint guard, whose drag resolves to MINIMIZE rather than discard (#1469).",
  "components/ProfileIdentityBar.tsx":
    "the mobile profile switcher. Converged onto components/overlay in the same way as ActivityOverlay — shared primitives, focus trap, body lock, contained scroller — and registered as a TOP-anchored OVERLAY_SURFACE in the chokepoint guard (#1801).",
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
 * String literals are copied through VERBATIM, comment openers and all. That is
 * load-bearing rather than fussy — `accept="image/*"` opens a phantom block
 * comment that would blank the next hundred lines, and a scan that silently
 * throws away source reports a green it never checked.
 */
export function withoutComments(text: string): string {
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
  const code = withoutComments(file.text);
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
const DIALOG_ROLE_RE = /(^|[\s{])role=\{?["'](dialog|alertdialog)["']/m;
const ARIA_MODAL_RE = /(^|[\s{])aria-modal[=\s]/m;

/** Does this file RENDER a dialog surface itself, rather than asking a host to? */
export function declaresOwnDialog(code: string): boolean {
  return DIALOG_ROLE_RE.test(code) || ARIA_MODAL_RE.test(code);
}

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
}

function handRolled(file: SourceFile, bindings: ImportedBinding[]): HandRolled {
  const code = withoutComments(file.text);
  const imports = (module: string, local?: string) =>
    bindings.some(
      (b) => b.module === module && (local == null || b.local === local)
    );
  const scrollerLines = code
    .split("\n")
    .filter((line) => /\boverflow-y-auto\b/.test(line));
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
    ownEscapeHandler: /["'`]Escape["'`]/.test(code),
    ownScroller: scrollerLines.length > 0,
    overscrollContained:
      scrollerLines.length > 0 &&
      scrollerLines.every((line) => /\boverscroll-contain\b/.test(line)),
    ownFullViewportLayer: /\bfixed inset-0\b/.test(code),
  };
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
}

export interface DialogCensus {
  filesScanned: number;
  entries: DialogEntry[];
  hosts: DialogEntry[];
  hosted: DialogEntry[];
  hostless: DialogEntry[];
  confirmCallers: DialogEntry[];
  /** Hostless on disk but absent from HOSTLESS_DIALOGS — the guard's failure. */
  unrecordedHostless: string[];
  /** Recorded in HOSTLESS_DIALOGS but no longer hostless on disk. */
  staleRecords: string[];
}

export function censusDialogs(files: SourceFile[]): DialogCensus {
  const entries: DialogEntry[] = [];
  for (const file of files) {
    const code = withoutComments(file.text);
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
    if (declaresOwnDialog(code)) {
      entries.push({
        rel: file.rel,
        kind: "hostless",
        hosts,
        via,
        handRolled: handRolled(file, bindings),
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
