import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_SECTIONS } from "@/lib/hrefs";
import { DATA_TAB_FIRST_PAGE } from "@/components/tab-first-pages";

// THE GUARD THAT KEEPS #4541 FROM COMING BACK.
//
// The Data hub's `?section=` union was declared TWICE and the two disagreed:
// `lib/hrefs.ts` listed `import | review | manage` under a comment claiming to be
// the source of truth, while the page declared its own five-value `SECTIONS` and
// never imported it. Nothing failed — so `dataSectionHref("coverage")` was a type
// error against a section the hub actually renders, and 27 links across
// app/, components/ and lib/ hand-built the literal the helper owns rather than
// call a helper that could not spell their destination.
//
// Deleting the page's copy fixes today. This is what makes tomorrow's copy fail:
// a union whose only defence is a comment gets re-declared, because re-declaring
// it is the path of least resistance for anyone who needs a section the helper
// does not have.
//
// The type system carries what it can: `DATA_TAB_FIRST_PAGE.tabs` is
// `satisfies`-bound to `DataSection`, so a strip naming an unknown section does
// not compile, and a narrowed union is a type error at every branch and caller.
// What no type can see is a SECOND declaration that AGREES — the shape this bug
// arrived in, and the shape it would return in. That is what the scans below are
// for, and each of them fails in both directions.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Where a hand-built section link would actually ship from. `e2e/` and the test
// tiers are deliberately out: a spec navigating to `/data?section=review` is
// asserting on the URL grammar, which is the thing under test, not a link.
const SCANNED_DIRS = ["app", "components", "lib"];
const TEST_DIR = /(?:^|\/)(?:__tests__|__db_tests__|__action_tests__)(?:\/|$)/;

// The two files that may spell the literal, each with the reason:
//   - the builder itself, which is the one place that composes the URL;
//   - this census, which must QUOTE it to have anything to scan for.
const ALLOWED = new Set([
  "lib/hrefs.ts",
  "lib/__tests__/data-section-union.test.ts",
]);

/** A hand-built `?section=` URL: the literal, opening quote included. */
const HAND_BUILT = /['"`]\/data\?section=/;

/**
 * A SECOND DECLARATION OF THE UNION, in the shape one actually takes: two or
 * more section names as adjacent string literals in an array. This is what
 * `const SECTIONS = ["import", "review", …]` looks like to a scanner, and it is
 * how the page's copy was spelled. The tab strip does not trip it — its sections
 * are `{ id, label }` objects, not bare adjacent strings.
 */
const SECOND_UNION = new RegExp(
  `"(?:${DATA_SECTIONS.join("|")})"\\s*,\\s*"(?:${DATA_SECTIONS.join("|")})"`
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scannedFiles(): { rel: string; text: string }[] {
  return SCANNED_DIRS.flatMap((dir) => walk(path.join(REPO, dir)))
    .map((full) => path.relative(REPO, full))
    .filter((rel) => !TEST_DIR.test(rel) && !ALLOWED.has(rel))
    .map((rel) => ({
      rel,
      text: fs.readFileSync(path.join(REPO, rel), "utf8"),
    }));
}

describe("the Data hub's section union has exactly one declaration", () => {
  it("the tab strip's ids and DATA_SECTIONS are the same sections", () => {
    const tabIds = DATA_TAB_FIRST_PAGE.tabs.map((tab) => tab.id);
    // Order too: the strip's reading order IS the union's, so a section added to
    // one and inserted elsewhere in the other still reads as drift.
    expect(tabIds).toEqual([...DATA_SECTIONS]);
  });

  it("no shipped file hand-builds a /data?section= link", () => {
    const offenders = scannedFiles()
      .filter(({ text }) => HAND_BUILT.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("no shipped file re-declares the union", () => {
    const offenders = scannedFiles()
      .filter(({ text }) => SECOND_UNION.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("the Data page parses ?section= through the shared parser", () => {
    const page = fs.readFileSync(
      path.join(REPO, "app/(app)/data/page.tsx"),
      "utf8"
    );
    expect(page).toContain("parseDataSection(searchParams.section)");
  });
});
