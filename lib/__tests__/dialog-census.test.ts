import { describe, expect, it } from "vitest";
import {
  censusDialogs,
  censusRepoDialogs,
  HOSTLESS_DIALOGS,
  HOST_MODULES,
  readSourceFiles,
  type SourceFile,
} from "@/scripts/dialog-census-core";

// The guard over the dialog census (#3405).
//
// WHAT IT FAILS ON, and deliberately what it does not. It fails when a dialog
// belonging to NO dialog host appears on disk without being recorded, and when a
// recorded one is no longer hostless. It does NOT fail on the recorded set
// itself. That restraint is the point: #3405 asks whether these components
// converge onto the host or are named in docs/internals/overlays.md as sanctioned
// exceptions, and says in as many words that this "is a design call about the
// convergence's boundary, not something a lane should decide". A build error on
// every recorded entry would force that unmade call to be made once per entry by
// whoever next touched the tree.
//
// THE OTHER HALF OF THIS FILE IS THE PART THAT MATTERS. A census that runs green
// over a tree which complies has told you nothing about what it can SEE. So below
// the register checks are fixtures authored to BREAK it — one for each way the
// grep it replaces was wrong — and, just as important, fixtures it must stay
// SILENT on. A census that cried wolf on the shared focus trap or on every menu
// would be deleted within a week, taking the real census with it.

const CENSUS = censusRepoDialogs();

/** A synthetic file, classified on its own so a fixture cannot disturb the tree. */
function classifyOne(rel: string, text: string) {
  const files: SourceFile[] = [{ rel, text }];
  const census = censusDialogs(files);
  return census.entries.find((e) => e.rel === rel) ?? null;
}

describe("dialog census — the register over the real tree", () => {
  it("every dialog belonging to no dialog host is recorded", () => {
    expect(
      CENSUS.unrecordedHostless,
      "This component renders a modal dialog of its own and goes through none of " +
        "the dialog hosts. Run `npm run census:dialogs -- --hostless` to see what " +
        // Derived, not typed: this sentence is a claim about the register, so it
        // reads the register. The prose version of it had already gone stale.
        `it answers for itself. It is not automatically wrong — ${
          Object.keys(HOSTLESS_DIALOGS).length
        } components ` +
        "already sit here — but it must be RECORDED in HOSTLESS_DIALOGS in " +
        "scripts/dialog-census-core.ts, stating factually what it hand-rolls, so the next " +
        "sweep of this family sees it. Silently belonging to no host is the " +
        "condition #3405 exists to end."
    ).toEqual([]);
  });

  it("does not keep a record that has outlived its subject", () => {
    expect(
      CENSUS.staleRecords,
      "This file is recorded as belonging to no dialog host, and it no longer " +
        "does — it converged, or it is gone. Drop the entry: a register that " +
        "outlives its reason is how the next reviewer learns to ignore it."
    ).toEqual([]);
  });

  it("records a substantive reason for each, not a shrug", () => {
    for (const [rel, note] of Object.entries(HOSTLESS_DIALOGS)) {
      expect(note.length, `${rel} needs a real note`).toBeGreaterThan(20);
    }
  });

  it("keeps the host modules where the failure messages say they are", () => {
    const onDisk = new Set(readSourceFiles().map((f) => f.rel));
    for (const rel of Object.keys(HOST_MODULES)) {
      expect(
        onDisk.has(rel),
        `${rel} is named as a host but is not on disk`
      ).toBe(true);
    }
  });

  // The census's own subject, pinned by symbol rather than by line number.
  it("puts MergeConflictDialog in the hostless list and NOT in the hosted one", () => {
    const rel = "components/MergeConflictDialog.tsx";
    expect(CENSUS.hostless.map((e) => e.rel)).toContain(rel);
    // The over-match that started #3405: the file mentions `ModalShell` in a
    // comment, and the filename grep counted that as using it.
    expect(CENSUS.hosted.map((e) => e.rel)).not.toContain(rel);
  });

  it("still sees the hosted majority, so the census is not merely quiet", () => {
    // A control in the other direction: if the host attribution broke, the
    // hostless list would swell and every assertion above would still pass.
    expect(CENSUS.hosted.length).toBeGreaterThan(20);
    expect(CENSUS.hosted.map((e) => e.rel)).toContain(
      "components/CommandPalette.tsx"
    );
  });

  // SILENCE ON THE BENIGN NEIGHBOURS, over the real tree.
  it("says nothing about the shared focus trap, which QUERIES for dialogs", () => {
    // components/useFocusTrap.ts asks `target.closest('[role="dialog"]')`.
    // Querying for dialogs is not being one.
    const rels = CENSUS.entries.map((e) => e.rel);
    expect(rels).not.toContain("components/useFocusTrap.ts");
  });

  it("says nothing about the menus and popovers", () => {
    const hostless = CENSUS.hostless.map((e) => e.rel);
    for (const rel of [
      "app/(app)/trends/ChartJumpMenu.tsx",
      "components/CompactDateMenu.tsx",
      "components/OverflowMenu.tsx",
      "components/LevelBadge.tsx",
      "components/MobileNav.tsx",
    ]) {
      expect(hostless, `${rel} is not a dialog`).not.toContain(rel);
    }
  });
});

describe("dialog census — what it can SEE", () => {
  // ── The OVER-match the filename grep made ──────────────────────────────────
  it("does not count a host named only in a comment", () => {
    const entry = classifyOne(
      "components/CommentOnly.tsx",
      `import { createPortal } from "react-dom";
       // Portal to <body> (matching ModalShell/ConfirmDialog): rendered inline.
       export default function CommentOnly() {
         return createPortal(
           <div className="fixed inset-0" role="dialog" aria-modal="true" />,
           document.body
         );
       }`
    );
    // This is components/MergeConflictDialog.tsx's exact shape. A file-level
    // grep for `ModalShell` put it in the HOSTED list off that comment alone.
    expect(entry?.kind).toBe("hostless");
  });

  it("does not count a host mentioned inside a block comment", () => {
    const entry = classifyOne(
      "components/BlockComment.tsx",
      `/* This surface used to import ModalShell from "@/components/ModalShell".
          It no longer does. */
       export default function BlockComment() {
         return <div className="fixed inset-0" role="dialog" />;
       }`
    );
    expect(entry?.kind).toBe("hostless");
  });

  it("does not count a host that is imported but never used", () => {
    const entry = classifyOne(
      "components/ImportedUnused.tsx",
      `import ModalShell from "@/components/ModalShell";
       export default function ImportedUnused() {
         return <div className="fixed inset-0" role="dialog" />;
       }`
    );
    // An import the file never applies is the import-level form of the same
    // over-match a comment produces.
    expect(entry?.kind).toBe("hostless");
  });

  // ── The UNDER-match the filename grep made ─────────────────────────────────
  it("sees a dialog that hand-rolls its own portal", () => {
    const entry = classifyOne(
      "components/HandRolledPortal.tsx",
      `import { createPortal } from "react-dom";
       export default function HandRolledPortal() {
         return createPortal(
           <div className="fixed inset-0 overflow-y-auto" role="dialog" aria-modal="true" />,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.handRolled?.portal).toBe(true);
    // It scrolls itself and does not contain the overscroll — the #2774 defect,
    // reported rather than merely counted.
    expect(entry?.handRolled?.overscrollContained).toBe(false);
  });

  it("sees a dialog that never portals at all", () => {
    const entry = classifyOne(
      "components/InlineDialog.tsx",
      `export default function InlineDialog() {
         return <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" />;
       }`
    );
    // THIS IS THE CASE NO EXISTING GUARD COULD SEE. The chokepoint test's
    // `isPortalOverlay` requires `createPortal` AND `fixed inset-0`, so a dialog
    // rendered inline is outside it by construction — and four such components
    // are on disk today.
    expect(entry?.kind).toBe("hostless");
    expect(entry?.handRolled?.portal).toBe(false);
  });

  it("sees a dialog declared with aria-modal but no role", () => {
    const entry = classifyOne(
      "components/AriaModalOnly.tsx",
      `export default function AriaModalOnly() {
         return <div className="fixed inset-0" aria-modal="true" />;
       }`
    );
    expect(entry?.kind).toBe("hostless");
  });

  it("sees an alertdialog, not just a dialog", () => {
    const entry = classifyOne(
      "components/AlertOne.tsx",
      `export default function AlertOne() {
         return <div className="fixed inset-0" role="alertdialog" />;
       }`
    );
    expect(entry?.kind).toBe("hostless");
  });

  // ── Matching on the MODULE, not on the symbol's spelling ───────────────────
  it("recognises a host imported under a different local name", () => {
    const entry = classifyOne(
      "components/RenamedHost.tsx",
      `import Shell from "@/components/ModalShell";
       export default function RenamedHost() {
         return <Shell title="Edit">body</Shell>;
       }`
    );
    // A guard pinned to the string "ModalShell" would call this hostless and be
    // wrong. Membership is the module path plus the local binding.
    expect(entry?.kind).toBe("hosted");
    expect(entry?.hosts).toContain("components/ModalShell.tsx");
  });

  it("recognises a host imported by a relative path", () => {
    const entry = classifyOne(
      "components/RelativeHost.tsx",
      `import ModalShell from "./ModalShell";
       export default function RelativeHost() {
         return <ModalShell title="Edit">body</ModalShell>;
       }`
    );
    expect(entry?.kind).toBe("hosted");
    expect(entry?.hosts).toContain("components/ModalShell.tsx");
  });

  it("does not count a TYPE import as rendering a surface", () => {
    const entry = classifyOne(
      "components/TypeOnly.tsx",
      `import { useConfirm, type ConfirmOptions } from "@/components/ConfirmDialog";
       export function useThing(opts: ConfirmOptions) {
         const confirm = useConfirm();
         return () => confirm(opts);
       }`
    );
    // components/useConfirmedAction.ts is exactly this, and the census counted
    // it as a dialog component until the type flag existed. It renders nothing.
    expect(entry?.kind).toBe("confirm-caller");
  });

  it("treats the confirm HOOK as reaching the host, not as a hostless dialog", () => {
    const entry = classifyOne(
      "components/ConfirmCaller.tsx",
      `import { useConfirm } from "@/components/ConfirmDialog";
       export default function ConfirmCaller() {
         const confirm = useConfirm();
         return <button onClick={() => confirm({ title: "Sure" })}>Delete</button>;
       }`
    );
    // The spelling this repo actually uses. A census that looked for a
    // `<ConfirmDialog>` element would have been blind to every one of these.
    expect(entry?.kind).toBe("confirm-caller");
  });

  // ── Silence, proven on the shapes that look like dialogs and are not ───────
  it("stays silent on a CSS selector that names the dialog role", () => {
    const entry = classifyOne(
      "components/TrapLike.ts",
      `export function trap(target: Element) {
         return target.closest('[role="dialog"]');
       }`
    );
    // components/useFocusTrap.ts, verbatim in shape. The discriminator is the
    // character before `role`: an attribute has whitespace there, a selector has
    // `[`.
    expect(entry).toBeNull();
  });

  it("stays silent on a menu that covers the viewport", () => {
    const entry = classifyOne(
      "components/MenuLike.tsx",
      `export default function MenuLike() {
         return (
           <div className="fixed inset-0 z-40">
             <div role="menu"><button role="menuitemradio">One</button></div>
           </div>
         );
       }`
    );
    expect(entry).toBeNull();
  });

  // THESE TWO ARE THE ONLY FIXTURES THAT EXERCISE THE COMMENT STRIPPER, and they
  // exist because disabling it left every other test in this file green. The
  // census resists a comment NAMING a host by construction — it matches import
  // STATEMENTS, not bare symbols — so nothing here reached `withoutComments`
  // until a fixture put a dialog attribute itself inside prose. An untested
  // stripper is a stripper the next reader deletes.
  it("stays silent on a dialog attribute written inside a line comment", () => {
    const entry = classifyOne(
      "components/LineCommentRole.tsx",
      `export default function LineCommentRole() {
         // The wrapper below used to carry role="dialog" and aria-modal="true".
         return <div className="p-4">plain content</div>;
       }`
    );
    expect(entry).toBeNull();
  });

  it("stays silent on a dialog attribute written inside a block comment", () => {
    const entry = classifyOne(
      "components/BlockCommentRole.tsx",
      `/* Anatomy note: a converged host renders role="dialog" for you, so a
          consumer never writes aria-modal="true" by hand. */
       export default function BlockCommentRole() {
         return <div className="p-4">plain content</div>;
       }`
    );
    expect(entry).toBeNull();
  });

  it("stays silent on a file that only names aria-modal in prose", () => {
    const entry = classifyOne(
      "components/ProseOnly.tsx",
      `// a11y (focus trap, Escape, \`aria-modal\`) is the SHARED useFocusTrap hook.
       export default function ProseOnly() {
         return <div className="p-4">nothing modal here</div>;
       }`
    );
    // components/BottomSheet.tsx carries this exact sentence at the top.
    expect(entry).toBeNull();
  });

  // ── Two ways a scanner silently throws source away ─────────────────────────
  it("is not derailed by a quoted string that looks like a comment opener", () => {
    const entry = classifyOne(
      "components/AcceptAttr.tsx",
      `export default function AcceptAttr() {
         return (
           <div>
             <input type="file" accept="image/*" />
             <div className="fixed inset-0" role="dialog" aria-modal="true" />
           </div>
         );
       }`
    );
    // `image/*` opened a phantom block comment in an earlier scanner and blanked
    // the next hundred lines — a scan reporting a green it never checked.
    expect(entry?.kind).toBe("hostless");
  });

  it("reads a source file that carries a NUL byte", () => {
    const entry = classifyOne(
      "components/NulByte.tsx",
      // A real NUL in the text being classified, written as an ESCAPE so this
      // test file itself does not join the NUL register in nul-byte-census.
      `const SEP = "\u0000";
       export default function NulByte() {
         return <div className="fixed inset-0" role="dialog" data-sep={SEP} />;
       }`
    );
    // Several source files in this repo carry a deliberate NUL as a composite-key
    // separator (#3206), and ripgrep calls those BINARY and skips them without
    // `-a` — reporting a sweep it never took. This census reads files with
    // node:fs, which has no such notion. Proven, not asserted.
    expect(entry?.kind).toBe("hostless");
  });
});
