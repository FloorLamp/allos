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
  it("each chip variant's source puts aria-expanded on its disclosure button", () => {
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
    }
    // The removable chip's × is the one button that is NOT a disclosure; it carries an
    // aria-label instead, and stays a second button beside the chip rather than a click
    // target overlapping it.
    expect(chipRow).toContain("aria-label={remove.label}");
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
  });

  it("imports the shared editor host and writes no Escape handling itself", () => {
    expect(host).toMatch(
      /import FactEditorHost(?:,\s*\{[^}]*\})?\s+from ["'][^"']*\/facts\/FactEditorHost["']/
    );
    expect(host).toContain("useFactEditor");
    // The Esc contract lives in the primitive, so no consumer re-implements it.
    expect(host).not.toContain('"Escape"');
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
