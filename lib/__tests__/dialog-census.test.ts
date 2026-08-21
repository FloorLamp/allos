import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  censusDialogs,
  censusRepoDialogs,
  declaresModalAnatomy,
  handRolled,
  HOSTLESS_DIALOGS,
  HOST_MODULES,
  importedBindings,
  readSourceFiles,
  REPO_ROOT,
  type HandRolled,
  type SourceFile,
} from "@/scripts/dialog-census-core";

/**
 * A real source file, read off disk, for use as a fixture.
 *
 * THE REACH FIXTURES BELOW USED TO BE ENTIRELY SYNTHETIC, and every one of them
 * spelled `role="dialog"` — the one thing the detector looked for. So the suite
 * could only ever prove that the detector saw the shape it had been written
 * from, and #3445 is what that cost: two real hand-rolled modal surfaces sat in
 * the tree unclassified while this suite ran green. A fixture the rule was
 * designed around cannot fail it; a file somebody else wrote can.
 */
function realFile(rel: string): SourceFile {
  return { rel, text: fs.readFileSync(path.join(REPO_ROOT, rel), "utf8") };
}

// The guard over the dialog census (#3405).
//
// WHAT IT FAILS ON, and deliberately what it does not. It fails when a dialog
// belonging to NO dialog host appears on disk without being recorded, when a
// recorded one is no longer hostless, and when the register and
// docs/internals/overlays.md disagree about who the exceptions are. It does NOT
// fail on the recorded set itself, and that restraint has a different reason now
// than it did when this file was written: the owner has RULED (#3405,
// 2026-08-20). Convergence is the default, the entries that remain are sanctioned
// exceptions with stated anatomy reasons, and a build error on a sanctioned
// exception is how a register teaches the next reader to ignore it.
//
// THE DOC IS PART OF THE CONTRACT, which is the half the ruling added. "Named in
// overlays.md with its reason" is an acceptance criterion, and an acceptance
// criterion nothing checks is a sentence that goes stale the first time somebody
// converges one of these. So the register and the doc's table are asserted to name
// the same files, in both directions.
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
    for (const [rel, record] of Object.entries(HOSTLESS_DIALOGS)) {
      expect(record.why.length, `${rel} needs a real note`).toBeGreaterThan(20);
    }
  });

  // THE DOC AND THE REGISTER NAME THE SAME FILES (#3405 AC 3). Asserted in both
  // directions on purpose: a register entry the doc never heard of is an
  // unsanctioned exception, and a doc row whose subject has converged is the
  // "record that outlived its reason" failure one layer up.
  //
  // MATCHED ON THE PATH INSIDE A TABLE ROW, not on a bare mention of the
  // filename. The doc's prose names several of these components while ARGUING
  // about them — the convergence history, the #1469 split — and a plain
  // `includes()` would read those as sanctions. The row is the sanction.
  it("names every recorded exception in docs/internals/overlays.md", () => {
    const doc = fs.readFileSync(
      path.join(REPO_ROOT, "docs/internals/overlays.md"),
      "utf8"
    );
    // SCOPED TO THE EXCEPTION TABLE, and that narrowing is #3445 one layer up.
    // This used to scan EVERY line in the document that starts with `|`, and
    // overlays.md carries three other tables that name components for entirely
    // unrelated reasons — the gesture table and the host-choice table both name
    // `components/MobileNav.tsx`. So a register entry could come back
    // "documented" off a row that sanctions nothing, which is a check whose scope
    // is wider than the question it is being asked. The sanction is a row under
    // the exception table's own header, so that is what is read.
    const lines = doc.split("\n");
    const headerAt = lines.findIndex((line) =>
      line.includes("Why the shared host cannot serve it")
    );
    expect(
      headerAt,
      "the hostless-dialog exception table's header moved or was reworded in " +
        "docs/internals/overlays.md — this guard reads the rows underneath it"
    ).toBeGreaterThan(-1);
    const tableRows: string[] = [];
    for (let i = headerAt + 1; i < lines.length; i += 1) {
      if (!lines[i].trimStart().startsWith("|")) break;
      tableRows.push(lines[i]);
    }
    const rows = new Set(
      tableRows
        .flatMap((line) => [...line.matchAll(/`([^`]+\.tsx?)`/g)])
        .map((m) => m[1])
    );
    const excepted = Object.entries(HOSTLESS_DIALOGS)
      .filter(([, record]) => record.scopedOut !== true)
      .map(([rel]) => rel);

    expect(
      excepted.filter((rel) => !rows.has(rel)),
      "This dialog is recorded as belonging to no host, and nothing in " +
        "docs/internals/overlays.md says why it is allowed to. Convergence is the " +
        "default (owner ruling, #3405): a dialog belongs on the shared host unless " +
        "the doc names it an exception WITH ITS REASON. Add a row to the " +
        "hostless-dialog table there, or converge it."
    ).toEqual([]);

    const documented = [...rows].filter((rel) => rel in HOSTLESS_DIALOGS);
    expect(
      documented.filter((rel) => HOSTLESS_DIALOGS[rel].scopedOut === true),
      "docs/internals/overlays.md lists this file in the EXCEPTION table, and the " +
        "register says it is scoped out of the dialog family by anatomy. Those are " +
        "different claims (#3405): move it to the scoped-out row."
    ).toEqual([]);
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
  //
  // IT CONVERGED (#3405 AC 3), so the assertion that used to hold here is now the
  // OPPOSITE one — and that inversion is the whole receipt. This file was in the
  // hostless list because it hand-rolled a portal while a comment in it merely
  // NAMED `ModalShell`; the filename grep read the comment and called it hosted,
  // which is the over-match that started this issue. It is hosted now for the real
  // reason: it imports the host and renders it.
  it("puts MergeConflictDialog in the HOSTED list, and no longer in the hostless one", () => {
    const rel = "components/MergeConflictDialog.tsx";
    expect(CENSUS.hosted.map((e) => e.rel)).toContain(rel);
    expect(CENSUS.hostless.map((e) => e.rel)).not.toContain(rel);
    const entry = CENSUS.hosted.find((e) => e.rel === rel);
    expect(entry?.hosts).toContain("components/ModalShell.tsx");
  });

  // The other two the ruling converged, pinned the same way. A convergence that
  // silently regressed would otherwise only show up as a NEW unrecorded hostless
  // dialog, which reads as somebody else's mistake.
  it("keeps the other two converged dialogs on the host", () => {
    for (const rel of [
      "components/PlateBuilderModal.tsx",
      "app/(app)/training/FitnessCheckView.tsx",
    ]) {
      expect(
        CENSUS.hosted.map((e) => e.rel),
        rel
      ).toContain(rel);
      expect(
        CENSUS.hostless.map((e) => e.rel),
        rel
      ).not.toContain(rel);
    }
  });

  // The scoped-out entry is reported as its own thing, not counted as an
  // exception. "The census and the guard should say so" is the ruling's wording.
  it("reports MobileDetailPage as scoped out by anatomy, not as an exception", () => {
    const rel = "components/MobileDetailPage.tsx";
    expect(CENSUS.scopedOut.map((e) => e.rel)).toEqual([rel]);
    expect(CENSUS.exceptions.map((e) => e.rel)).not.toContain(rel);
    // …and it is still SEEN. Scoping out is not filtering out.
    expect(CENSUS.hostless.map((e) => e.rel)).toContain(rel);
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
      // TWO ARRIVED IN THIS LIST IN #3445. Both portal and both handle Escape,
      // so the widened anatomy route reaches them and is held out by one clause
      // — see the clause-by-clause test below, which is the one that would
      // notice if that stopped being true.
      "components/Combobox.tsx",
      "components/InfoTooltipIcon.tsx",
    ]) {
      expect(hostless, `${rel} is not a dialog`).not.toContain(rel);
    }
    // ── AND TWO LEFT IT IN #3445 ─────────────────────────────────────────────
    //
    // `LevelBadge` and `MobileNav` used to be asserted here, as menus. Neither
    // was a menu. Both were listed because the census produced no entry for
    // them, and it produced no entry for them because neither spells
    // `role="dialog"` — so this assertion was reading the detector's own blind
    // spot back as a fact about the tree, which is the whole of #3445 in one
    // line. LevelBadge was a centred card over an `OVERLAY_SCRIM_TINT` scrim and
    // renders ModalShell now; MobileNav is a recorded exception. Both are pinned
    // below, in the direction that is now true.
  });

  // ── THE NEAR-MISSES, CLAUSE BY CLAUSE, ON REAL FILES ───────────────────────
  //
  // The three assertions above say only "not hostless", which a detector that
  // had gone blind again would also satisfy. These say WHICH clause of
  // `declaresModalAnatomy` holds each file out, on the real source — so a
  // widening that swallowed a near-miss, or a narrowing that stopped reaching
  // it at all, both read differently here.
  //
  // THESE ARE THE FIXTURES NOBODY WROTE FOR THE RULE. Every synthetic fixture in
  // the second half of this file was authored by whoever was holding the
  // detector, which is exactly how #3445 happened: the reach suite and the
  // detector shared a premise, so the suite could only ever confirm it. These
  // three files were written for their own reasons by people who had never heard
  // of this census.
  it("names the clause that holds each real near-miss out", () => {
    const cases: [string, keyof HandRolled, string][] = [
      [
        "components/CompactDateMenu.tsx",
        "portal",
        "It DOES cover the viewport — `fixed inset-0 z-20` — but that layer is a " +
          "transparent click-catcher rendered inline under an anchored day menu. " +
          "It never leaves its own DOM neighbourhood: no portal, no body lock.",
      ],
      [
        "components/Combobox.tsx",
        "ownFullViewportLayer",
        "It portals and it handles Escape, but the panel is anchored to its " +
          "input. A popover positioned against its trigger is not a modal surface.",
      ],
      [
        "components/InfoTooltipIcon.tsx",
        "ownFullViewportLayer",
        "The same shape: a portalled tooltip anchored to its icon, with Escape.",
      ],
    ];
    for (const [rel, absentClause, why] of cases) {
      const file = realFile(rel);
      const hr = handRolled(file, importedBindings(file));
      expect(hr[absentClause], `${rel}: ${why}`).toBe(false);
      expect(declaresModalAnatomy(hr), `${rel}: ${why}`).toBe(false);
      expect(CENSUS.hostless.map((e) => e.rel)).not.toContain(rel);
    }
  });

  // ── The two the widened detector found (#3445) ─────────────────────────────
  //
  // Pinned as REAL FILES rather than as fixtures, because the defect was that
  // every reach fixture had been written from the detector's own premise. These
  // two cannot be: nobody wrote them to be found.
  it("classifies MobileNav, which declares no role and no aria-modal", () => {
    const entry = CENSUS.hostless.find((e) => e.rel === "components/MobileNav.tsx");
    expect(
      entry,
      "The mobile nav drawer portals to <body>, covers the viewport with its own " +
        "scrimmed `fixed inset-0`, takes the shared body lock and handles Escape. " +
        "It carries no `role` and no `aria-modal`, which is exactly why the census " +
        "could not see it (#3445). If it has converged onto the dialog host, drop " +
        "its HOSTLESS_DIALOGS entry — do not weaken the detector."
    ).toBeDefined();
    // FOUND BY WHAT IT RENDERS, not by what it says. If somebody adds
    // `role="dialog"` to the drawer this flips to "aria" and the anatomy route
    // stops being exercised by a real file — which is worth knowing, so it is
    // asserted rather than left to drift.
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.portal).toBe(true);
    expect(entry?.handRolled?.sharedBodyLock).toBe(true);
    expect(entry?.handRolled?.scrim).toBe(true);
  });

  it("puts the converged LevelBadge on the host, not in the register", () => {
    const rel = "components/LevelBadge.tsx";
    // It was a hand-rolled centred card over a `bg-slate-900/40` scrim with no
    // ARIA at all — the anatomy #3445 describes, live in the tree. The census
    // found it, and the answer was convergence, which is the default.
    expect(CENSUS.hosted.map((e) => e.rel)).toContain(rel);
    expect(CENSUS.hostless.map((e) => e.rel)).not.toContain(rel);
    expect(CENSUS.hosted.find((e) => e.rel === rel)?.hosts).toContain(
      "components/ModalShell.tsx"
    );
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

  // ── The UNDER-match the ARIA-only detector made (#3445) ────────────────────
  //
  // Every fixture above spells `role="dialog"`, `role="alertdialog"` or
  // `aria-modal` — the one thing `declaresOwnDialog` looked for. That is the
  // defect #3445 filed: the reach suite and the detector were written from the
  // same premise, so a green suite meant only that the detector saw the shape it
  // had been given. NOTHING BELOW THIS LINE MAY SPELL A DIALOG ROLE.
  //
  // EVERY CLAUSE BELOW WAS MUTATED, one at a time, and the fixture that caught
  // each is named. A clause no fixture can kill is untested, and two of these
  // were: `dismissible`'s Escape arm and its labelled-Close arm both survived
  // the first pass, because every other modal here offers a second way out. The
  // two fixtures that isolate them were written in response, not in advance.
  //
  //   declaresModalAnatomy, full-viewport clause  → the real near-miss test, and
  //                                                 the unrecorded-hostless guard
  //   declaresModalAnatomy, portal/body-lock      → the same two
  //   declaresModalAnatomy, dismissible           → the blocking curtain
  //   declaresOwnDialog, native <dialog>          → the native element
  //   DIALOG_ROLE_RE, the computed-role group     → the runtime role
  //   dismissible, scrim-tag onClick              → the separate scrim child
  //   dismissible, layer-tag onClick              → the portalled catcher
  //   dismissible, labelled Close                 → the Close-only modal
  //   dismissible, Escape                         → the Escape-only modal
  //   SCRIM_RE, the OVERLAY_SCRIM token half      → MobileNav, on disk
  //   SCRIM_RE, the literal-tint half             → the hand-rolled card
  //   the anatomy route in censusDialogs at all   → MobileNav, and the stale-record guard
  //
  // A WARNING FOR WHOEVER RE-RUNS THIS. The first harness reported all twelve
  // mutants KILLED, and it was reading its own exit code after passing vitest an
  // invalid `--reporter=basic`, which fails at STARTUP with exit 1 — so every
  // mutant "died" without one test having run. Take the verdict from the named
  // failing tests, never from the exit status alone.

  it("sees a hand-rolled modal that declares no role and no aria-modal", () => {
    // components/LevelBadge.tsx as it stood on main at 6de40080, its
    // load-bearing attributes copied across and the reference table elided. It
    // shipped like this: a portal, a scrim that is `OVERLAY_SCRIM_TINT`
    // verbatim, a centred card, a heading and a ✕ — a modal dialog with the ARIA
    // left off, invisible to the census for exactly the reason it was
    // inaccessible. It is a ModalShell consumer now; the anatomy is kept here
    // because it is the one specimen of this shape nobody invented.
    const entry = classifyOne(
      "components/HandRolledNoAria.tsx",
      `import { createPortal } from "react-dom";
       import { IconX } from "@tabler/icons-react";
       export default function HandRolledNoAria({ open, setOpen }) {
         return open && createPortal(
           <div
             className="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/40 p-4 sm:p-8 dark:bg-black/70"
             onClick={() => setOpen(false)}
           >
             <div
               className="w-full max-w-lg rounded-xl bg-surface p-4 shadow-xl sm:p-5"
               onClick={(e) => e.stopPropagation()}
             >
               <h2 className="text-lg font-bold">Strength standards</h2>
               <button type="button" onClick={() => setOpen(false)} aria-label="Close">
                 <IconX className="h-5 w-5" />
               </button>
             </div>
           </div>,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    // FOUND BY WHAT IT RENDERS. If this ever reads "aria", somebody has put a
    // role into the fixture and it has stopped testing the under-match.
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.portal).toBe(true);
    expect(entry?.handRolled?.scrim).toBe(true);
    expect(entry?.handRolled?.dismissible).toBe(true);
  });

  it("sees a modal that locks the body instead of portalling", () => {
    // The OTHER arm of "leaves its own DOM neighbourhood". A dialog rendered in
    // place that takes the shared reference-counted body lock has left it just
    // as surely as one that portals, and the lock is the thing a menu never
    // takes.
    const entry = classifyOne(
      "components/LockedNoPortal.tsx",
      `import { useLockBodyScroll } from "@/components/useLockBodyScroll";
       export default function LockedNoPortal({ open, onClose }) {
         useLockBodyScroll(open);
         return open ? (
           <div className="fixed inset-0 bg-slate-900/40" onClick={onClose}>
             <div className="mx-auto mt-20 max-w-lg rounded-xl bg-surface p-4">body</div>
           </div>
         ) : null;
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.portal).toBe(false);
    expect(entry?.handRolled?.sharedBodyLock).toBe(true);
  });

  it("sees a modal whose only dismissal is a click on a separate scrim child", () => {
    // components/MobileNav.tsx's shape: the `fixed inset-0` wrapper takes no
    // click, and the dismissal lives on an `absolute inset-0` scrim INSIDE it.
    // No Escape, no labelled Close — so this fixture reaches `dismissible`
    // through the scrim arm alone, which nothing else here exercises.
    const entry = classifyOne(
      "components/ScrimClickOnly.tsx",
      `import { createPortal } from "react-dom";
       export default function ScrimClickOnly({ onClose }) {
         return createPortal(
           <div className="fixed inset-0 z-40">
             <div className="absolute inset-0 bg-black/50" onClick={onClose} />
             <div className="absolute inset-y-0 left-0 w-72 bg-surface">nav</div>
           </div>,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.ownEscapeHandler).toBe(false);
    expect(entry?.handRolled?.dismissible).toBe(true);
  });

  it("sees a modal whose only dismissal is Escape", () => {
    // A dialog can decline the scrim tap on purpose and still be dismissible.
    // Nothing else in this file reaches `dismissible` through Escape ALONE — the
    // real drawer and the hand-rolled card both offer a second route — so
    // without this fixture the Escape arm is a clause no test can kill.
    const entry = classifyOne(
      "components/EscapeOnlyModal.tsx",
      `import { createPortal } from "react-dom";
       export default function EscapeOnlyModal({ onClose }) {
         useEffect(() => {
           const onKey = (e) => { if (e.key === "Escape") onClose(); };
           document.addEventListener("keydown", onKey);
           return () => document.removeEventListener("keydown", onKey);
         }, [onClose]);
         return createPortal(
           <div className="fixed inset-0 z-60 grid place-items-center bg-black/40">
             <div className="w-full max-w-lg rounded-xl bg-surface p-4">body</div>
           </div>,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.ownEscapeHandler).toBe(true);
    expect(entry?.handRolled?.dismissible).toBe(true);
  });

  it("sees a modal whose only dismissal is a labelled Close control", () => {
    // The other arm on its own: no Escape, no click on the layer or the scrim,
    // just the ✕. Same reason as above — the arm needs a fixture that can kill
    // it, and every other modal here offers a second route out.
    const entry = classifyOne(
      "components/CloseButtonOnlyModal.tsx",
      `import { createPortal } from "react-dom";
       export default function CloseButtonOnlyModal({ onClose }) {
         return createPortal(
           <div className="fixed inset-0 z-60 grid place-items-center bg-black/40">
             <div className="w-full max-w-lg rounded-xl bg-surface p-4">
               <button type="button" aria-label="Close" onClick={onClose}>x</button>
               body
             </div>
           </div>,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.ownEscapeHandler).toBe(false);
    expect(entry?.handRolled?.dismissible).toBe(true);
  });

  it("sees a portalled full-viewport layer whose only dismissal is its own click", () => {
    // THE BIAS IN ITS LEAST COMFORTABLE FORM, and it is stated here rather than
    // hidden: a transparent catcher with no scrim, no Escape and no labelled
    // Close, which portals and takes the whole viewport. It could be a menu's
    // catcher that somebody moved into a portal to escape a stacking context.
    // It is REPORTED anyway — the module's stated bias is to report and let a
    // human decide, and the answer costs one register entry with a reason in it.
    // Staying silent here would cost the register its meaning, which is the
    // trade #3445 is about.
    const entry = classifyOne(
      "components/PortalledCatcher.tsx",
      `import { createPortal } from "react-dom";
       export default function PortalledCatcher({ onClose }) {
         return createPortal(
           <div className="fixed inset-0 z-40" onClick={onClose}>
             <div className="mx-auto mt-24 w-80 rounded-xl bg-surface p-4">panel</div>
           </div>,
           document.body
         );
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("anatomy");
    expect(entry?.handRolled?.scrim).toBe(false);
    expect(entry?.handRolled?.ownEscapeHandler).toBe(false);
    expect(entry?.handRolled?.dismissible).toBe(true);
  });

  it("sees a role computed at runtime", () => {
    // `role={danger ? "alertdialog" : "dialog"}` DOES declare an ARIA dialog
    // role; the first spelling of the pattern required a quote immediately after
    // the optional `{`, so it matched neither branch (#3445). Reached by ARIA,
    // not by anatomy — this fixture renders no layer at all, which is what makes
    // it a test of the regex rather than of the anatomy route.
    const entry = classifyOne(
      "components/ComputedRole.tsx",
      `export default function ComputedRole({ danger }) {
         return <div role={danger ? "alertdialog" : "dialog"} className="p-4" />;
       }`
    );
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("aria");
  });

  it("sees a native <dialog> element", () => {
    const entry = classifyOne(
      "components/NativeDialog.tsx",
      `export default function NativeDialog({ ref }) {
         return <dialog ref={ref} className="rounded-xl p-4">body</dialog>;
       }`
    );
    // The element whose entire purpose is to be a dialog, and the ARIA-only
    // detector could not see it — it carries the role implicitly.
    expect(entry?.kind).toBe("hostless");
    expect(entry?.declaredBy).toBe("aria");
  });

  // ── Silence, on the shapes the WIDENED rule must not swallow (#3445) ───────
  //
  // A rule biased toward reporting is only affordable while the volume stays
  // small enough that a human reads the register. These are the three ways a
  // full-viewport-ish surface is not a dialog, and each one is a clause of
  // `declaresModalAnatomy` doing its job.

  it("stays silent on a blocking curtain with no dismissal", () => {
    const entry = classifyOne(
      "components/SavingCurtain.tsx",
      `import { createPortal } from "react-dom";
       export default function SavingCurtain({ saving }) {
         return saving ? createPortal(
           <div className="fixed inset-0 z-90 grid place-items-center bg-slate-900/40">
             <p className="text-sm">Saving…</p>
           </div>,
           document.body
         ) : null;
       }`
    );
    // A curtain the viewer cannot dismiss is not a dialog — it is a guard over
    // an in-flight write, or a splash, or a route transition. Nothing here is
    // asking the viewer anything.
    expect(entry).toBeNull();
  });

  it("stays silent on a portalled popover anchored to its trigger", () => {
    const entry = classifyOne(
      "components/AnchoredPopover.tsx",
      `import { createPortal } from "react-dom";
       export default function AnchoredPopover({ rect, onClose }) {
         useEffect(() => {
           const onKey = (e) => { if (e.key === "Escape") onClose(); };
           window.addEventListener("keydown", onKey);
           return () => window.removeEventListener("keydown", onKey);
         }, [onClose]);
         return createPortal(
           <div className="absolute z-50 rounded-lg bg-surface p-2 shadow-lg" style={{ top: rect.bottom, left: rect.left }}>
             menu
           </div>,
           document.body
         );
       }`
    );
    // components/Combobox.tsx and components/InfoTooltipIcon.tsx, in shape: they
    // portal and they handle Escape, and they own no part of the viewport. The
    // real files are asserted silent above; this fixture is what makes the
    // failure legible if the clause ever goes.
    expect(entry).toBeNull();
  });

  it("stays silent on a full-viewport click-catcher rendered inline", () => {
    const entry = classifyOne(
      "components/InlineCatcher.tsx",
      `export default function InlineCatcher({ open, setOpen }) {
         useEffect(() => {
           const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
           document.addEventListener("keydown", onKey);
           return () => document.removeEventListener("keydown", onKey);
         }, [setOpen]);
         return open ? (
           <div className="relative">
             <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
             <div className="absolute top-full z-30 rounded-lg bg-surface p-2">days</div>
           </div>
         ) : null;
       }`
    );
    // components/CompactDateMenu.tsx, in shape. It covers the viewport and it
    // dismisses, but the catcher is transparent and rendered in place: no
    // portal, no body lock, nothing left its own neighbourhood.
    expect(entry).toBeNull();
  });

  it("stays silent on a tag that merely starts with the letters dialog", () => {
    const entry = classifyOne(
      "components/DialogueTag.tsx",
      `export default function DialogueTag() {
         return (
           <Dialogue>
             <dialog-lite open>a line of dialogue</dialog-lite>
           </Dialogue>
         );
       }`
    );
    // The native-element pattern requires a DELIMITER after `<dialog` — a space,
    // a `>` or a `/`. `<dialog-lite` has a hyphen, so a lowercase custom element
    // cannot match; `<Dialogue>` cannot either, the pattern being lowercase and
    // JSX components being capitalised; and neither can a closing `</dialog>`,
    // where the character after `<` is `/`. Without the delimiter, every one of
    // these would have joined the register.
    expect(entry).toBeNull();
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
