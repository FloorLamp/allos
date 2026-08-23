import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";

// Static data-accessibility guard for wide tables on phones (issue #794, cluster 6).
// The app's main content is `overflow-x-clip`, so a table wider than the viewport
// SILENTLY CLIPS its rightmost columns on a narrow screen — the data is simply
// unreachable, no scrollbar, no hint. The fix is wrap-and-scroll: every `<table>`
// lives inside a horizontal-scroll container so overflow becomes a swipe, not a
// clip. Three markers satisfy that container:
//   - `overflow-x-auto` — the plain wrapper `<div className="overflow-x-auto">`.
//   - `overflow-auto`    — the `max-h-[…] overflow-auto` wrappers (scroll both axes,
//                          used where a tall table also wants a sticky header).
//   - `<ScrollFade>`     — components/ScrollFade.tsx, itself an `overflow-x-auto`
//                          container that additionally fades the scrollable edge.
//   - `<ResponsiveTable>`— components/ResponsiveTable.tsx (issue #1426): the table
//                          stops being a table below `sm` and stacks as cards over
//                          the SAME DOM, so there is no horizontal overflow left to
//                          scroll. A stronger answer than wrap-and-scroll, not a
//                          weaker one — sideways-swiping a data table on a phone
//                          hides the columns that matter even when it "works".
// COMMENTS ARE BLANKED BEFORE ANYTHING IS MATCHED (#3595). This reads source as
// TEXT, and prose in this tree routinely quotes the very construct it is explaining:
// `app/(app)/results/clinical-results/view/page.tsx:991` was a comment saying what
// `ResponsiveTable` had replaced, and this scan read it as a rendered table. The
// lane that met it reworded the comment, which fixed that file and left the scanner
// unchanged. The sibling scanner in this tier
// (`lib/__tests__/add-affordance-grammar.test.ts`) already blanks comments, so the
// repo held both behaviours and the difference was nobody's decision.
//
// The blanking happens INSIDE `unwrappedTables` rather than at the call site, so a
// caller cannot forget it. `lib/__tests__/strip-comments.ts` blanks in place —
// same byte length, same newlines — so the `:line` numbers reported below are still
// the file's real ones, and the WRAPPER WINDOW below still spans the same source.
//
// It matters in both directions and the expensive one is quiet. A `<table` in prose
// is a false positive somebody notices; the same missing step is why
// `logged-via-surface-wiring.test.ts` once swallowed 1,244 lines of a file and
// reported a clean sweep it never took.
//
// This reads the repo's own JSX as TEXT (no DB, no browser, so it stays "pure" in
// the vitest sense) and fails the build if any `<table>` occurrence lacks a scroll
// container NEARBY. Tightened for #1491 guard 12b: the old check was per FILE, so
// a second, unwrapped table slipped through as long as any table in the file had a
// wrapper. Now every `<table` occurrence must have a marker within the preceding
// window of source text — a proximity heuristic, not a real JSX ancestry check,
// but the wrapper is always immediately above the table it wraps in this codebase,
// so a marker further away than the window is exactly the drift worth flagging.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for rendered UI source.
const SCAN_DIRS = ["app", "components"];

// Markers that give a `<table>` a working narrow-viewport strategy: a
// horizontal-scroll container, or the card-stacking primitive that removes the
// horizontal axis altogether.
const SCROLL_MARKERS =
  /overflow-x-auto|overflow-auto|<ScrollFade\b|<ResponsiveTable\b/;

// How much source text ABOVE a `<table` occurrence is searched for a marker.
// Wrappers sit directly above their table; 800 characters spans the wrapper
// element plus its attributes and a comment block, while staying far too small
// to let a wrapper at the top of the file excuse an unwrapped table below.
const WRAPPER_WINDOW = 800;

// Files allowed to render a `<table>` without any of those markers because they use
// a DIFFERENT, deliberate narrow-viewport strategy:
//  - components/ResponsiveTable.tsx IS the card-stacking primitive — it emits the
//    `<table className="table-cards">` the CSS re-lays as cards below `sm`, so it
//    can't be asked to wrap itself in a scroller.
// (components/ClinicalResultsTable.tsx used to live here as a column-hider — hiding
// Panel/Notes/Category below `md`. It now renders through <ResponsiveTable> (#1426),
// so those columns come BACK on a phone as card meta lines instead of being dropped.)
const ALLOWLIST = new Set<string>(["components/ResponsiveTable.tsx"]);

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * THE FLOOR THE CORPUS MUST CLEAR, asserted before any verdict is pronounced over
 * it. The verdict is an ABSENCE — "no unwrapped table" — which is the shape that
 * passes hardest once the walk has stopped reaching the tree.
 *
 * Measured 2026-08-23 at this head: 1,044 `.ts`/`.tsx` files under `app/` (548)
 * and `components/` (496) after the test-tier exclusions, 17 of which render a
 * `<table`. The floor is deliberately slack;
 * what it catches is the corpus collapsing toward zero, which `readdirSync` over a
 * renamed root does loudly but `SCAN_DIRS`, `isExcluded` or the extension filter
 * quietly do not.
 */
const CORPUS_FLOOR = 500;

/**
 * Every `<table` occurrence with no narrow-viewport strategy in the window above
 * it, as `rel:line`.
 *
 * COMMENTS ARE BLANKED HERE, not by the caller. `stripComments` preserves byte
 * offsets and newlines, so `m.index`, the wrapper window and the reported line
 * number all still address the real file.
 */
export function unwrappedTables(
  files: readonly { rel: string; text: string }[],
  allowlist: ReadonlySet<string> = ALLOWLIST
): string[] {
  const offenders: string[] = [];
  for (const { rel, text } of files) {
    if (allowlist.has(rel)) continue;
    const code = stripComments(text);
    const re = /<table\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const above = code.slice(Math.max(0, m.index - WRAPPER_WINDOW), m.index);
      if (!SCROLL_MARKERS.test(above))
        offenders.push(`${rel}:${code.slice(0, m.index).split("\n").length}`);
    }
  }
  return offenders;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("wide-table mobile scroll boundary (issue #794 cluster 6)", () => {
  const files = sourceFiles();

  it("reads the corpus it is about to pronounce clean", () => {
    expect(
      files.length,
      `The scan read ${files.length} source files under ${SCAN_DIRS.join(", ")}, ` +
        `below the floor of ${CORPUS_FLOOR}. Either the walk has stopped reaching ` +
        "them (a root renamed, an extension filter that no longer matches, an " +
        "exclusion that widened) or the app really shrank — check which before " +
        "lowering this number."
    ).toBeGreaterThanOrEqual(CORPUS_FLOOR);

    // Per root, because the total clears the floor while one root has silently
    // dropped out — `app/` alone would carry it.
    for (const dir of SCAN_DIRS)
      expect(
        files.filter((f) => f.rel.startsWith(`${dir}/`)).length,
        `No file at all under \`${dir}\`. That root is either gone from the tree ` +
          "or gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);

    // And the corpus really contains the construct this scan is about. A corpus
    // with no `<table` in it agrees that every table is wrapped.
    expect(
      files.filter((f) => /<table\b/.test(stripComments(f.text))).length,
      "No rendered `<table` anywhere in the corpus. The verdict below is then an " +
        "absence over a corpus that could not have produced a finding."
    ).toBeGreaterThan(3);
  });

  it("every rendered <table> sits inside a nearby horizontal-scroll container (or a deliberate column-hider)", () => {
    const offenders = unwrappedTables(files);
    expect(
      offenders,
      `These <table> occurrences have no narrow-viewport strategy nearby, so ` +
        `wide columns clip silently on a phone. Render them through ` +
        `<ResponsiveTable> (it stacks as cards below sm — #1426), wrap them in ` +
        `<div className="overflow-x-auto"> (or <ScrollFade>) directly above, or ` +
        `— for a deliberate different strategy — allowlist the file here:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every allowlisted file still exists and renders a table", () => {
    for (const rel of ALLOWLIST) {
      const abs = path.join(REPO, rel);
      expect(fs.existsSync(abs), `${rel} is allowlisted but missing`).toBe(
        true
      );
      expect(/<table\b/.test(fs.readFileSync(abs, "utf8"))).toBe(true);
    }
  });
});

// Everything above proves the scan is CLEAN over a tree that already complies, which
// says nothing about what it can SEE (#3325). These run the same scanner over a
// corpus authored to break it — a real file written to disk, walked and read back,
// so it is the walk and the blanking that have to do the work rather than a string
// handed to the matcher.
//
// A CORPUS OF ITS OWN, never the live tree: vitest runs test files concurrently and
// several other guards walk `app/` and `components/` and read them a moment later,
// so a create-then-unlink there kills unrelated tests with ENOENT (measured on
// #3557's tap-floor census). It is made with `makeTmpDir` so this file is not itself
// an offender against the temp-dir census (#3248).
describe("the scan can see, and stays quiet on the prose that explains it", () => {
  const base = makeTmpDir("table-scroll-corpus");

  const write = (rel: string, source: string): string => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, "utf8");
    return rel;
  };
  const scan = (rels: readonly string[]): string[] =>
    unwrappedTables(
      rels.map((rel) => ({
        rel,
        text: fs.readFileSync(path.join(base, rel), "utf8"),
      })),
      new Set<string>()
    );

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("flags a real unwrapped <table>, at its true line number", () => {
    // The line number is the point. `stripComments` blanks in place, so a comment
    // ABOVE the offender must not shift the number the reader is given — that is
    // what would send someone to the wrong line of a 900-line file.
    const rel = write(
      "app/(app)/planted/UnwrappedTable.tsx",
      [
        "export function P() {",
        "  /* A block comment above the table, four lines tall,",
        "     so a stripper that deleted instead of blanking would",
        "     report line 6 as line 3. */",
        "  return (",
        "    <table>",
        "      <tbody />",
        "    </table>",
        "  );",
        "}",
        "",
      ].join("\n")
    );
    expect(scan([rel])).toEqual([`${rel}:6`]);
  });

  it("reads no table out of a comment — the #3595 case, verbatim", () => {
    // The real shape: `app/(app)/results/clinical-results/view/page.tsx:991` was a
    // comment explaining what `<ResponsiveTable>` had replaced, and the scan read it
    // as a rendered table. Both comment spellings, because JSX prose is written in
    // `{/* … */}` as often as in `//`.
    const rel = write(
      "app/(app)/planted/CommentOnly.tsx",
      [
        "export function P() {",
        "  // This used to be a bare <table> before #1426 moved it to cards.",
        "  return (",
        "    <div>",
        '      {/* the old <table className="w-full"> lived here */}',
        "      <p>no table</p>",
        "    </div>",
        "  );",
        "}",
        "",
      ].join("\n")
    );
    expect(scan([rel])).toEqual([]);
  });

  it("does not accept a wrapper that only exists in a comment", () => {
    // The other direction, and the expensive one. Blanking comments must not hand a
    // real offender an excuse: a `overflow-x-auto` written in prose above a table is
    // not a scroll container, and before the blanking it satisfied the window.
    const rel = write(
      "app/(app)/planted/WrapperInProse.tsx",
      [
        "export function P() {",
        '  // The wrapper below used to be <div className="overflow-x-auto">.',
        "  return (",
        "    <div>",
        "      <table>",
        "        <tbody />",
        "      </table>",
        "    </div>",
        "  );",
        "}",
        "",
      ].join("\n")
    );
    expect(
      scan([rel]),
      "A wrapper named only in prose excused a real unwrapped table. Blanking " +
        "comments is what makes this direction work, and it is the direction " +
        "nobody notices."
    ).toEqual([`${rel}:5`]);
  });

  it("stays silent on each real wrapper, and on the card-stacking primitive", () => {
    const rels = [
      write(
        "components/planted/Scroller.tsx",
        'export const P = () => (\n  <div className="overflow-x-auto">\n    <table />\n  </div>\n);\n'
      ),
      write(
        "components/planted/Fade.tsx",
        "export const P = () => (\n  <ScrollFade>\n    <table />\n  </ScrollFade>\n);\n"
      ),
      write(
        "components/planted/Cards.tsx",
        "export const P = () => (\n  <ResponsiveTable>\n    <table />\n  </ResponsiveTable>\n);\n"
      ),
    ];
    expect(scan(rels)).toEqual([]);
  });

  it("finds the SECOND table in a file whose first one is wrapped (#1491 guard 12b)", () => {
    // The wrapper is real, and far enough above the second table to be outside the
    // window. The filler is sized from WRAPPER_WINDOW so the test cannot quietly
    // stop being about distance if that constant moves.
    const filler = "    <span />";
    const fillerLines = Math.ceil(WRAPPER_WINDOW / (filler.length + 1)) + 5;
    const lines = [
      "export const P = () => (",
      "  <>",
      '    <div className="overflow-x-auto">',
      "      <table />",
      "    </div>",
      ...Array.from({ length: fillerLines }, () => filler),
      "    <table />",
      "  </>",
      ");",
      "",
    ];
    const rel = write("components/planted/TwoTables.tsx", lines.join("\n"));
    expect(scan([rel])).toEqual([`${rel}:${6 + fillerLines}`]);
  });
});
