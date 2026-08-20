import { describe, it, expect } from "vitest";
import fs from "node:fs";
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
// So this source-scan pins two things: the primitive carries the contract, and the first
// consumer (#3216's intake form) MOUNTS it rather than re-implementing it. Every further
// surface (#3219–#3223) is expected to add itself to CONSUMERS.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

const chipRow = read("components/facts/FactChipRow.tsx");
const editorHost = read("components/facts/FactEditorHost.tsx");

// Each consumer: the file that renders its chips, and the file that hosts its one editor.
// They are often the same file; the intake form splits them.
const CONSUMERS = [
  {
    name: "the one intake form (#3216)",
    chips: "components/intake/IntakeFactRow.tsx",
    host: "components/IntakeItemForm.tsx",
  },
] as const;

describe("the facts-with-editors primitive carries the contract (#3218)", () => {
  it("every chip variant is a button with aria-expanded", () => {
    // Three variants — the stated/missing fact, the "+ thing" prompt, the trailing
    // "more" — and a chip that is not a disclosure is the one bug that is invisible
    // to sighted testing.
    const buttons = chipRow.match(/<button\b/g) ?? [];
    const expanded = chipRow.match(/aria-expanded=/g) ?? [];
    // The removable chip's × is the one button that is not a disclosure; it carries an
    // aria-label instead.
    expect(buttons.length).toBe(expanded.length + 1);
    expect(chipRow).toContain("aria-label={remove.label}");
  });

  it("a missing essential renders dashed and an absent optional renders nothing", () => {
    expect(chipRow).toContain("data-fact-state={state}");
    expect(chipRow).toMatch(/state === "missing"/);
    expect(chipRow).toContain("border-dashed");
  });

  it("the host owns Done and Esc as the same gesture, yielding the first Esc to a picker", () => {
    expect(editorHost).toContain("useFactEditor");
    expect(editorHost).toMatch(/event\.key !== "Escape"/);
    // The combobox yield: an Escape aimed at an EXPANDED listbox belongs to the listbox.
    expect(editorHost).toContain('getAttribute("role") === "combobox"');
    expect(editorHost).toContain('getAttribute("aria-expanded") === "true"');
    expect(editorHost).toContain("doneLabel");
  });

  it("the primitive owns no domain logic and no store", () => {
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

describe.each(CONSUMERS)("$name consumes the primitive", (consumer) => {
  const chips = read(consumer.chips);
  const host = read(consumer.host);

  it("mounts the shared chip components instead of drawing chips itself", () => {
    expect(chips).toMatch(
      /import FactChipRow(?:,\s*\{[^}]*\})?\s+from ["'][^"']*\/facts\/FactChipRow["']/
    );
    // A consumer that still writes its own chip button has forked the contract.
    expect(chips).not.toContain("aria-expanded=");
    expect(chips).not.toContain("data-fact-state=");
  });

  it("mounts the shared editor host instead of drawing its own Done", () => {
    expect(host).toMatch(
      /import FactEditorHost(?:,\s*\{[^}]*\})?\s+from ["'][^"']*\/facts\/FactEditorHost["']/
    );
    expect(host).toContain("useFactEditor");
    // The Esc contract lives in the primitive, so no consumer re-implements it.
    expect(host).not.toContain('"Escape"');
  });
});
