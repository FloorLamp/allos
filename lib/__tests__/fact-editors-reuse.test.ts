import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #3218: facts-with-editors is ONE shared primitive, not a shape each form redraws.
//
// The pattern's whole value is that every consumer announces itself the same way — a
// chip is a disclosure with `aria-expanded`, a missing essential is dashed, at most one
// editor is on screen, and Done and Esc are the same gesture. A second surface that
// copies the markup instead of the component gets those right on the day it ships and
// wrong on the first day someone fixes one of them, in one place, out of two.
//
// So this source-scan pins two things: the primitive (`components/facts/FactChipRow`
// and `components/facts/FactEditorHost`) carries the contract, and every consumer
// MOUNTS it rather than re-implementing it.
//
// EVERY TEST HERE IS A SOURCE CLAIM AND IS NAMED AS ONE (#3300). Source scan is the
// right tier for the anti-fork question — "did a second surface copy the markup instead
// of the component" genuinely is a question about source — but a name promising a
// RUNTIME fact its body never asks about makes a green suite mean less than it says.
// The runtime behaviour is covered where it can be observed: the e2e specs that assert
// `data-fact-state`, `data-suggested` and `data-panel` against a real browser.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Spelled this way, rather than as a string escape, so THIS file stays plain text and
// never has to appear in the deliberate-NUL registry (#3206).
const NUL = String.fromCharCode(0);

function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

const CHIP_ROW_MODULE = "components/facts/FactChipRow.tsx";
const EDITOR_HOST_MODULE = "components/facts/FactEditorHost.tsx";

const chipRow = read(CHIP_ROW_MODULE);
const editorHost = read(EDITOR_HOST_MODULE);

// Each consumer: the file that renders its chips, and the file that hosts its one editor.
// They are often the same file; the intake form splits them.
//
// THIS TABLE IS COMPARED AGAINST A CENSUS OF THE TREE, not merely read (#3300). See
// `factPrimitiveImporters` below: a file that imports either primitive without a row
// here fails, and a row here naming a file that imports neither fails too. Before that
// comparison existed this was a hand-maintained list, which is blind to precisely the
// case the suite exists to catch — a surface that FORKED the markup instead of
// importing the component has no reason to add itself.
const CONSUMERS = [
  {
    name: "the one intake form (#3216)",
    chips: "components/intake/IntakeFactRow.tsx",
    host: "components/IntakeItemForm.tsx",
  },
  {
    name: "the manual sleep-and-mood entry (#3222)",
    chips: "components/sleep/SleepFactRow.tsx",
    host: "app/(app)/sleep/SleepMoodEditDialog.tsx",
  },
  {
    // The FIRST consumer that is a real <form>, and the first whose editor is not the
    // whole surface — the chips sit in one section of a long editor (#3334).
    //
    // It is NOT DOM-collected, which is the distinction the row below turns on: its
    // <form> only `preventDefault`s and `buildFormData` composes every field by hand
    // out of React state, so it carries no `name=` at all (see the note at the top of
    // components/ActivityForm.tsx, which records that refutation).
    name: "the activity editor's session facts (#3334)",
    chips: "components/activity-form/ActivitySessionFactRow.tsx",
    host: "components/ActivityForm.tsx",
  },
  {
    // THE SECOND CHIPS FILE BEHIND ONE HOST (#3336) — the mirror of the visit pair
    // below, which is one chips file behind two hosts.
    //
    // Its chip states a strength part's sets as the ONE compact notation every other
    // surface renders — "60 kg × 8 × 3" — and what opens behind it is THE SET GRID
    // ITSELF, not a FactEditorHost panel. That is the pattern's own reading, not an
    // exemption from it: #3218's preconditions exclude a surface whose fields are free
    // numeric entry (the measurements form is the recorded counter-case), and #3228
    // invokes that workbench exclusion by name for this grid and for live mode. So this
    // consumer takes the chip half and leaves the panel half alone.
    //
    // It is registered against the activity editor's EXISTING host because that is what
    // the census below actually asks — which files import the primitive — and because
    // ActivityForm is genuinely where this editor's one fact panel lives (#3334).
    name: "the activity editor's compact set notation (#3336)",
    chips: "components/activity-form/StrengthSets.tsx",
    host: "components/ActivityForm.tsx",
  },
  {
    // THE FIRST DOM-COLLECTED CONSUMER (#3219) — a different "first" from the one
    // above, and the two are worth reading together. The three consumers before this
    // all hand their action a FormData they built themselves; this one is
    // `<form action={handle}>` with twelve NAMED inputs, so the browser gathers the
    // FormData from whatever is mounted at submit.
    //
    // That is why its closed panels stay mounted and merely hidden — the primitive's
    // other documented reading, and the one #2014 states — and why it keeps its
    // previously-uncontrolled fields DOM-owned: a controlled field's `defaultValue` is
    // kept in sync with its value by React, and the dirty-form registry reads
    // `defaultValue` as the saved value, so a controlled field can never be dirty.
    // e2e/protocol-facts.spec.ts pins both halves at runtime.
    name: "the protocol form (#3219)",
    chips: "components/protocols/ProtocolFactRow.tsx",
    host: "app/(app)/protocols/ProtocolForm.tsx",
  },
  {
    // The visit pair (#3223), and the first consumer whose chips file is mounted by TWO
    // hosts: an appointment and an encounter state the same facts in the same words, so
    // the row is written once and each tense's form supplies its own columns and its own
    // Server Action behind it.
    name: "the appointment branch of the visit pair (#3223)",
    chips: "components/encounters/VisitFactRow.tsx",
    host: "app/(app)/encounters/AppointmentForm.tsx",
  },
  {
    name: "the encounter branch of the visit pair (#3223)",
    chips: "components/encounters/VisitFactRow.tsx",
    host: "app/(app)/encounters/EncounterForm.tsx",
  },
  {
    // THE LAST OF THE FIVE QUEUED ADOPTERS (#3220), and the largest DOM-collected
    // surface in the tree: 30 named inputs across four kind branches, of which a given
    // goal uses six. It is also the first consumer whose SEEDING PICK decides which
    // fields exist at all — the subject pick derives the kind, so the chip that states
    // the kind is marked as a suggestion and opens the same editor the subject does.
    //
    // Its previously-uncontrolled fields stay DOM-owned for the reason the protocol row
    // above records, and its closed panels stay mounted for the same one. The single
    // exception is the exercise target's metric-conditional block, which mounts only
    // the inputs its metric uses: on a REPS goal `target_weight_kg` is read as a weight
    // FLOOR by `bestValueForGoal`, so a leftover number would silently change which
    // sets count. e2e/goal-facts.spec.ts pins both.
    name: "the training-goal form (#3220)",
    chips: "components/training/GoalFactRow.tsx",
    host: "app/(app)/training/GoalForm.tsx",
  },
] as const;

// Files that name the primitive's module paths without consuming it, and so are not
// consumers: the primitive itself, and this census.
const NOT_CONSUMERS = new Set<string>([
  CHIP_ROW_MODULE,
  EDITOR_HOST_MODULE,
  "lib/__tests__/fact-editors-reuse.test.ts",
]);

const IMPORTS_A_PRIMITIVE =
  /\bfrom\s*["'][^"']*\/facts\/(?:FactChipRow|FactEditorHost)["']/;

/**
 * Every tracked file that imports either half of the primitive.
 *
 * THE FILE LIST COMES FROM `git ls-files -z` AND THE CONTENT FROM A DIRECT READ, which
 * is what makes this census exhaustive. An `rg <pattern>` sweep would NOT be: several
 * files in this repo carry a deliberate NUL as a composite-key separator, ripgrep
 * classifies those as binary and SKIPS them without `-a`, and the sweep then reports a
 * clean result it never took (#3206, `lib/__tests__/nul-byte-census.test.ts`). Reading
 * the bytes ourselves has no such blind spot, so a forked consumer cannot hide behind
 * one. If you ever reimplement this as a shell sweep, it needs `rg --binary`.
 */
function factPrimitiveImporters(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split(NUL)
    .filter(Boolean);

  return tracked
    .filter((rel) => /\.tsx?$/.test(rel) && !NOT_CONSUMERS.has(rel))
    .filter((rel) => IMPORTS_A_PRIMITIVE.test(read(rel)))
    .sort();
}

describe("the facts-with-editors primitive carries the contract (#3218)", () => {
  it("each chip variant's source puts aria-expanded and data-focus-key on its disclosure button", () => {
    // Three disclosure variants — the stated/missing fact, the "+ thing" prompt, the
    // trailing "more" — and a chip that is not a disclosure is the one bug invisible to
    // sighted testing.
    //
    // Asked PER VARIANT rather than by comparing a count of `<button` against a count of
    // `aria-expanded`. Equal-ish counts do not mean the attributes are on the right
    // buttons (three of each satisfies it with all three misaligned), and a count
    // comparison goes red the day someone adds an unrelated button, under a name that
    // sends the reader hunting an accessibility regression that is not there (#3300).
    for (const variant of ["FactChip", "FactAddChip", "FactMoreChip"]) {
      const body = exportedFunctionSource(chipRow, variant);
      expect(
        body,
        `${variant} is exported from ${CHIP_ROW_MODULE}`
      ).toBeTruthy();
      expect(body, `${variant} renders a disclosure`).toContain(
        "aria-expanded={expanded}"
      );
      // And NAMES ITSELF (#3311). Opening an editor unmounts the whole chip row, so the
      // element the person activated is gone by the time the editor closes; this key is
      // what useFactEditor asks the row for to put focus back. A variant that stops
      // emitting it loses the return path silently — nothing is visibly wrong on
      // screen, and the next Tab starts from the top of the document.
      //
      // Asked as the CHIP's key rather than the panel's, because they are two questions
      // and the intake form answers them differently: one chip per rule sentence, all
      // opening the one rules builder.
      expect(body, `${variant} names itself for focus return`).toContain(
        "data-focus-key={focusKey}"
      );
    }
    // The removable chip's × is the one button that is NOT a disclosure; it carries an
    // aria-label instead, and stays a second button beside the chip rather than a click
    // target overlapping it.
    expect(chipRow).toContain("aria-label={remove.label}");
  });

  it("the chip row's source builds the suggestion marking once, for both chip shapes", () => {
    // #3222: `data-suggested` shipped on the REMOVABLE chip only, so the plain chip had
    // no marking and each consumer invented its own badge testid instead — a convention
    // the third surface can simply forget. Marking a chip as a suggestion rather than a
    // stated fact is the difference between prefilling and asserting (#846), so it is a
    // structural property of a chip, not a per-consumer courtesy.
    //
    // Asked as "exactly one place constructs the attribute, and both shapes use it",
    // because two branches that each spell it out is precisely the arrangement that
    // drifts.
    expect(chipRow.match(/"data-suggested":/g)?.length).toBe(1);

    // A SECOND ASSERTION USED TO STAND HERE counting `suggestedAttrs(suggested)` call
    // sites, and it is gone on purpose (#3318) rather than lost. It named a private call
    // expression and went red on a harmless rename; it was kept only because the
    // REMOVABLE branch had no unconditional runtime pin — the intake spec's marking
    // assertion sat behind `if (await suggested.count())` and asserted nothing when no
    // seeded rule matched. `e2e/one-intake-form.spec.ts` now picks a catalog entry whose
    // label ALWAYS proposes a rule and asserts "1" and then "0" on that chip with no
    // guard, so the runtime claim can no longer skip and the brittle stand-in has done
    // its job. The line above stays: it asks about the ATTRIBUTE, which is the contract,
    // not about the code that produces it.
  });

  it("the chip row's source declares data-fact-state and a dashed missing variant", () => {
    // A source claim, named as one. That a missing essential actually RENDERS dashed,
    // and that an absent optional renders nothing at all, are runtime facts this body
    // never asks about — the second belongs to the consumer's fact module, which is what
    // decides a fact is absent, and both are asserted by the e2e specs that read
    // `data-fact-state`.
    expect(chipRow).toContain("data-fact-state={state}");
    expect(chipRow).toMatch(/state === "missing"/);
    expect(chipRow).toContain("border-dashed");
  });

  it("the editor host's source carries useFactEditor, its Escape branch and the combobox yield", () => {
    expect(editorHost).toContain("useFactEditor");
    expect(editorHost).toMatch(/event\.key !== "Escape"/);
    // The combobox yield: an Escape aimed at an EXPANDED listbox belongs to the listbox.
    expect(editorHost).toContain('getAttribute("role") === "combobox"');
    expect(editorHost).toContain('getAttribute("aria-expanded") === "true"');
    expect(editorHost).toContain("doneLabel");
  });

  it("the editor host's source restores focus in three tiers, ending at the row", () => {
    // A SOURCE CLAIM, and named as one, because the last tier has no runtime pin and
    // cannot get one from either consumer today (#3311).
    //
    // Focus goes to the chip, else to the trailing affordance the absent fact went back
    // inside, else to the row. The e2e specs cover the first two against a real browser:
    // one-intake-form.spec.ts asserts the chip, the replacement chip, the trailing
    // affordance, and the rule sentence that was opened rather than the first.
    //
    // THE ROW TIER IS UNREACHABLE FROM THE TWO SURFACES THAT EXIST. Intake renders a
    // trailing affordance whenever a fact is absent, so tier two always answers there;
    // the sleep dialog has no trailing affordance but every one of its three facts
    // always draws a chip, so tier one always answers there. It is the floor for the
    // queued adopters (#3219-#3223) — a surface with neither — and without it that
    // combination silently lands on <body>, which is the whole defect. So it is pinned
    // where it CAN be pinned, rather than deleted for being untestable or claimed as
    // covered by a test that never reaches it.
    expect(editorHost).toContain('[data-focus-key="');
    expect(editorHost).toContain(
      'querySelector<HTMLElement>("[data-fact-more]")'
    );
    expect(editorHost).toContain(
      'querySelector<HTMLElement>("[data-fact-row]")'
    );
  });

  it("neither primitive module imports lib, a draft store, a form or an action", () => {
    for (const src of [chipRow, editorHost]) {
      expect(src).not.toMatch(/from "@\/lib\//);
      expect(src).not.toContain("useFormDraft");
      // No Server Action, no <form>: the primitive is chips and a panel, and every
      // consumer keeps its own existing write path untouched.
      expect(src).not.toContain("<form");
      expect(src).not.toMatch(/\baction=/);
    }
  });
});

describe("CONSUMERS is a census of the tree, not a list someone remembers (#3300)", () => {
  it("lists exactly the files that import either half of the primitive", () => {
    const registered = [
      ...new Set(CONSUMERS.flatMap((c) => [c.chips, c.host])),
    ].sort();
    // Set EQUALITY, both directions at once: a surface that mounts the primitive without
    // a row above fails here, and so does a row naming a file that has stopped importing
    // it. Either way the fix is one line in CONSUMERS — the point is that nothing lands
    // silently.
    //
    // If you are ADDING a consumer and it is missing from the left-hand side, the file is
    // probably not staged yet: the census walks `git ls-files`, so an untracked new
    // component is invisible to it. `git add` it and re-run.
    expect(factPrimitiveImporters()).toEqual(registered);
  });

  it("still finds an importer in a file carrying a NUL, and ignores a prose mention", () => {
    // A census is worth only what it can SEE, and a green run over a tree that happens to
    // comply proves nothing about that. So the read-and-match path is run over a file
    // written to defeat the obvious implementation: a consumer whose source carries a raw
    // NUL, which ripgrep calls binary and skips without `-a` (#3206).
    const dir = mkdtempSync(path.join(os.tmpdir(), "fact-census-"));
    const forked = path.join(dir, "ForkedSurface.tsx");
    writeFileSync(
      forked,
      'import FactChipRow from "@/components/facts/FactChipRow";\n' +
        "const KEY = profileId + " +
        NUL +
        " + slug;\n"
    );
    expect(readFileSync(forked).includes(0)).toBe(true);
    expect(IMPORTS_A_PRIMITIVE.test(readFileSync(forked, "utf8"))).toBe(true);

    // And it does not fire on a file that merely names the module in prose.
    expect(
      IMPORTS_A_PRIMITIVE.test(
        "// see components/facts/FactChipRow for the contract"
      )
    ).toBe(false);
  });
});

describe.each(CONSUMERS)("$name consumes the primitive", (consumer) => {
  const chips = read(consumer.chips);
  const host = read(consumer.host);

  it("imports the shared chip components and writes no chip attributes itself", () => {
    expect(chips).toMatch(
      /import FactChipRow(?:,\s*\{[^}]*\})?\s+from ["'][^"']*\/facts\/FactChipRow["']/
    );
    // A consumer that still writes its own chip button has forked the contract.
    expect(chips).not.toContain("aria-expanded=");
    expect(chips).not.toContain("data-fact-state=");
    // Including the suggestion marking: a consumer supplies the WORDING through `badge`
    // and the boolean through `suggested`, never the attribute itself.
    expect(chips).not.toContain("data-suggested=");
    // Same for the focus key (#3311): the consumer NAMES each chip through `focusKey`
    // and the primitive decides what attribute that becomes.
    expect(chips).not.toContain("data-focus-key=");
    expect(chips).toContain("focusKey=");
  });

  it("imports the shared editor host and writes no Escape handling itself", () => {
    expect(host).toMatch(
      /import FactEditorHost(?:,\s*\{[^}]*\})?\s+from ["'][^"']*\/facts\/FactEditorHost["']/
    );
    expect(host).toContain("useFactEditor");
    // The Esc contract lives in the primitive, so no consumer re-implements it.
    expect(host).not.toContain('"Escape"');
    // And it hands the primitive the region the chips and the editor share, which is
    // what lets focus come back to the chip on close (#3311). Required by the hook's
    // type too — this says out loud that forgetting it is a contract break, because the
    // symptom is invisible: nothing on screen is wrong, focus is just on <body>.
    expect(host).toContain("scopeRef");
  });
});

/**
 * The source of one exported function component, from its `export … function NAME(` to
 * the next top-level export. Enough to ask which attributes a given variant renders
 * without pulling in a parser for four components.
 */
function exportedFunctionSource(src: string, name: string): string | null {
  const start = src.search(
    new RegExp(`export\\s+(?:default\\s+)?function\\s+${name}\\b`)
  );
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport\s/);
  return next === -1 ? rest : rest.slice(0, next);
}
