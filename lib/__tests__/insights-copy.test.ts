import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Trends → Insights says what you get, not how it is wired (#3715).
//
// Both generate forms on that tab carried the same sentence — "Uses Claude when
// ANTHROPIC_API_KEY is set; otherwise a built-in summary is generated." A provider
// name and an environment variable are operator facts: nothing a person reading their
// own health trends can act on, and not the register the rest of the app speaks in.
//
// Scoped to THIS FILE on purpose, and it is not a tree-wide copy rule. #3715 records
// the finding as a point copy bug rather than a class, other user-facing surfaces name
// the same variable in copy this issue does not rule on (components/CoverageGaps.tsx,
// lib/medical-extract/extract.ts), and a sweep would have to either widen into them or
// carry an allow-list of them — which is the shape that gets deleted, taking the guard
// with it. One file, no exceptions list, deletable the day the tab is rewritten.
const SOURCE = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
  "app/(app)/trends/InsightsSection.tsx"
);

describe("the Insights tab's reader-facing copy", () => {
  // Read once: the assertions below are about one file's text, and re-reading it per
  // case would only make three chances to read a different file.
  const source = fs.readFileSync(SOURCE, "utf8");

  it.each([
    ["an environment variable", /ANTHROPIC_API_KEY/],
    ["a model provider", /\bClaude\b/],
  ])("names no %s", (_what, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it("still tells the reader what a summary without AI is", () => {
    // The absence assertions above are equally satisfied by deleting the sentence, and
    // the limitation is real — the recap cards show a "n/a" model badge when it fires.
    // So this is the control: something must still say it, in the reader's terms.
    expect(source).toMatch(/simpler summary/);
  });
});
