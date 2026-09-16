#!/usr/bin/env node
// Check all Markdown and dispatch/brief sources against a word budget.
// Usage: node scripts/check-doc-brevity.mjs [--base <git-ref>]
//
// GENERATED BLOCKS COUNT ON NEITHER SIDE OF THE COMPARISON (#4769). Text fenced by
// `<!-- BEGIN GENERATED: … -->` / `<!-- END GENERATED: … -->` is written by a
// generator and sized by the registry behind it. Nobody can shorten it, so no
// budget should ask them to, and a budget that does is a wall rather than an
// incentive: docs/internals/time-columns.md is 4,358 words of which 3,941 are that
// fence, `limit = Math.max(1500, oldCount)` therefore made the doc its own limit,
// and declaring one more temporal column in lib/time-columns.ts failed the lint
// tier with the repo-wide total failing alongside it. That stood in front of every
// new table with a TEXT temporal column, and the only way past it was deleting
// unrelated prose to pay for a table no person wrote.
//
// BY MARKER, NOT BY FILENAME. Any generator that fences its output the way
// lib/time-columns.ts does is exempt on the same terms; today exactly one file
// carries the pair.
//
// BOTH SIDES, THROUGH ONE FUNCTION, DELIBERATELY. `words()` below is the only
// counter in this file, and both the merge-base blob (`oldCount`) and the working
// tree (`count`) reach it — so exempting one side and not the other is not a thing
// this file can express. It is the mistake worth naming: skip the block only on the
// working-tree side and the first run after this lands reads as a 3,941-word
// DELETION, which under the repo-wide `total > oldTotal` rule silently hands the
// whole repository that much free headroom to spend on prose anywhere at all.
// Nothing fails, nobody looks, and the budget is gone. lib/__tests__/doc-brevity.test.ts
// pins `oldTotal` and `total` together across the transition for that reason.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const git = (...argv) =>
  execFileSync("git", argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

// The fence as lib/time-columns.ts writes it, with the label left open. Single
// line only (`[^\n]`): a marker mangled across lines is not a marker, and reading
// one as if it were would fence off everything up to the next `-->` in the file.
const BEGIN_GENERATED = /<!--\s*BEGIN GENERATED:[^\n]*?-->/g;
const END_GENERATED = /<!--\s*END GENERATED:[^\n]*?-->/g;

/**
 * `text` with every CLOSED generated block removed, markers included.
 *
 * AN UNMATCHED `BEGIN` COUNTS ITS TEXT — it does not skip to end of file. A
 * truncated file, a hand edit or a mid-rebase conflict then merely counts in full,
 * which someone notices and fixes; the other direction lets one broken marker buy
 * unlimited headroom, silently. lib/__tests__/strip-comments.ts settles the same
 * question the same way for its own scanner, and the reasoning transfers whole:
 * where a scanner is unsure, failing toward "count it" is noise, and failing toward
 * "drop it" is a false pass.
 *
 * MULTIPLE PAIRS ARE ALL SKIPPED, and the prose BETWEEN one `END` and the next
 * `BEGIN` is kept — a file may hold several generated tables with real paragraphs
 * threaded between them. No file does today, which is precisely why it is pinned
 * by a test rather than left to whoever writes the second one.
 */
export function withoutGeneratedBlocks(text) {
  let kept = "";
  let from = 0;
  BEGIN_GENERATED.lastIndex = 0;
  for (let open; (open = BEGIN_GENERATED.exec(text));) {
    END_GENERATED.lastIndex = open.index + open[0].length;
    const close = END_GENERATED.exec(text);
    if (!close) break; // Unmatched opener: the rest of the file is ordinary text.
    kept += text.slice(from, open.index);
    from = close.index + close[0].length;
    BEGIN_GENERATED.lastIndex = from;
  }
  return kept + text.slice(from);
}

export const words = (text) =>
  withoutGeneratedBlocks(text).match(/\S+/g)?.length ?? 0;

const covered = (name) =>
  /\.md$/i.test(name) ||
  /^scripts\/.*(?:dispatch|brief)[^/]*\.(?:[cm]?js|tsx?)$/i.test(name);

function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: npm run docs:check -- [--base <git-ref>]\nNew/short files: 1500 words. Oversized files and the total: no growth from the base.\nText between <!-- BEGIN GENERATED: … --> and <!-- END GENERATED: … --> is not counted, on either side."
    );
    process.exit(0);
  }
  if (args.length && (args.length !== 2 || args[0] !== "--base")) {
    console.error("Usage: npm run docs:check -- [--base <git-ref>]");
    process.exit(1);
  }
  try {
    process.chdir(git("rev-parse", "--show-toplevel").trim());
    const requestedBase =
      args[1] || process.env.DOC_BREVITY_BASE || "origin/main";
    const base = git("merge-base", "HEAD", requestedBase).trim();
    const previous = new Set(
      git("ls-tree", "-rz", "--name-only", base).split("\0").filter(covered)
    );
    const files = [
      ...new Set([
        ...git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
          .split("\0")
          .filter(covered),
        ...previous, // Files deleted since the base still count toward its total.
      ]),
    ].sort();
    let failures = 0;
    let checked = 0;
    let total = 0;
    let oldTotal = 0;
    for (const file of files) {
      const oldCount = previous.has(file)
        ? words(git("show", `${base}:${file}`))
        : 0;
      oldTotal += oldCount;
      if (!existsSync(file)) continue; // Deleted files have no remaining prose.
      // A symlink counts as git stores it: its target path, not the target file.
      const count = words(
        lstatSync(file).isSymbolicLink()
          ? readlinkSync(file)
          : readFileSync(file, "utf8")
      );
      total += count;
      const limit = Math.max(1500, oldCount);
      checked++;
      if (count > limit) {
        console.error(
          `${file}: ${count} words; limit ${limit} (+${count - limit}). Rewrite or remove duplication.`
        );
        failures++;
      }
    }
    const delta = `${total >= oldTotal ? "+" : ""}${total - oldTotal}`;
    if (total > oldTotal) {
      console.error(
        `Total: ${total} words; base ${oldTotal} (${delta}). New text displaces old: remove as many words as you add.`
      );
      failures++;
    }
    console.log(
      `Doc brevity: ${checked} files checked against ${base.slice(0, 12)}; ${total} words, ${oldTotal} at base (${delta}); ${failures} over budget.`
    );
    process.exitCode = failures ? 1 : 0;
  } catch (error) {
    console.error(
      `Doc brevity could not run: ${error.message}\nFetch the comparison base or pass --base <available-ref>.`
    );
    process.exitCode = 1;
  }
}

// RUN ONLY AS A PROGRAM. The body above chdir's and shells out to git, so an
// `import` of this file used to execute a whole repository scan — which is why the
// counter had no test. This is the repository's existing entrypoint idiom
// (scripts/orchestration/session-metrics.mjs, scripts/flake-census.mjs and four
// others) rather than Node 24's `import.meta.main`: `.nvmrc` pins 24 and would
// carry it, but the value is `undefined` on Node 22, where the guard would turn a
// version skew into a check that exits 0 having checked nothing.
const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) main(process.argv.slice(2));
