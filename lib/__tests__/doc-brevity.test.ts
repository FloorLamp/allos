import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  withoutGeneratedBlocks,
  words,
} from "../../scripts/check-doc-brevity.mjs";

// THE GENERATED-BLOCK EXEMPTION, PINNED ON BOTH SIDES OF THE COMPARISON (#4769).
//
// `check-doc-brevity.mjs` compares a working file against the same file in the
// merge-base blob. Text fenced by `<!-- BEGIN GENERATED: … -->` /
// `<!-- END GENERATED: … -->` is exempt from both counts, so regenerating a
// machine-written table reads as ZERO WORDS MOVED and the doc it lives in stops
// being its own limit.
//
// WHAT THESE DRIVES EXIST TO CATCH, because the obvious test does not catch it.
// "The doc can now grow" passes on the BROKEN implementation — the one that skips
// the block on the working-tree side and still counts it in the base. That version
// reads the first run after the change as a 3,941-word DELETION and, under the
// repo-wide `total > oldTotal` rule, quietly hands the whole repository that much
// free headroom for prose anywhere at all. Nothing goes red; the budget is simply
// gone. So the drives below assert the TWO NUMBERS TOGETHER — `total` and
// `oldTotal` from the script's own report line — and one of them removes the block
// outright and checks that no headroom came with it.
//
// They drive the SCRIPT, not just the counter, because both halves of the bug live
// in how the script wires the counter up.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/check-doc-brevity.mjs");

const BEGIN = "<!-- BEGIN GENERATED: time-column index -->";
const END = "<!-- END GENERATED: time-column index -->";

// The unexempt count: what the script measured before this change, and what the
// assertions below compare against so no expectation is a copied magic number.
const raw = (text: string): number => text.match(/\S+/g)?.length ?? 0;

/** `n` distinct words, so a miscount cannot hide behind a repeated token. */
const say = (stem: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${stem}${i}`).join(" ");

const block = (rows: number): string =>
  `${BEGIN}\n\n| column | grain |\n| --- | --- |\n${say("row", rows)}\n\n${END}`;

interface Report {
  status: number;
  stdout: string;
  stderr: string;
  total: number;
  oldTotal: number;
}

/**
 * A one-commit git repository whose committed state is `base`, with `working`
 * left uncommitted in the tree — exactly the shape the script compares.
 */
function checkDoc(base: string, working: string = base): Report {
  const dir = makeTmpDir("doc-brevity");
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  const doc = path.join(dir, "doc.md");
  fs.writeFileSync(doc, base);
  git("add", "-A");
  git("commit", "-qm", "base");
  const sha = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(doc, working);
  const run = spawnSync(process.execPath, [SCRIPT, "--base", sha], {
    cwd: dir,
    encoding: "utf8",
  });
  const line = /; (\d+) words, (\d+) at base/.exec(run.stdout);
  if (!line) {
    throw new Error(
      `no report line from the script: ${run.stdout}${run.stderr}`
    );
  }
  return {
    status: run.status ?? -1,
    stdout: run.stdout,
    stderr: run.stderr,
    total: Number(line[1]),
    oldTotal: Number(line[2]),
  };
}

describe("doc brevity: the generated block counts on neither side", () => {
  const prose = `${say("intro", 20)}\n\n${block(100)}\n\n${say("outro", 10)}`;
  const proseOnly = raw(say("intro", 20)) + raw(say("outro", 10));

  it("counts a file as its prose, in the working tree AND in the base blob", () => {
    // The whole ruling in one line: an untouched file reads as its 30 words of
    // prose on both sides, not its 100-odd words of table. Exempting only the
    // working side would report `30 words, <much more> at base` and pass — which
    // is why the base number is asserted and not just the delta.
    const report = checkDoc(prose);
    expect(report.total).toBe(proseOnly);
    expect(report.oldTotal).toBe(proseOnly);
    expect(raw(prose)).toBeGreaterThan(proseOnly); // the fixture has a block at all
    expect(report.status).toBe(0);
  });

  it("reads a regenerated, larger block as zero words moved", () => {
    // The deadlock: one more temporal column is one more row, and the doc is its
    // own limit under `limit = Math.max(1500, oldCount)`.
    const grown = `${say("intro", 20)}\n\n${block(400)}\n\n${say("outro", 10)}`;
    const report = checkDoc(prose, grown);
    expect(report.total).toBe(report.oldTotal);
    expect(report.stdout).toContain("(+0)");
    expect(report.status).toBe(0);
  });

  it("hands out no headroom when the block is removed entirely", () => {
    // THE LOOPHOLE, DRIVEN. Delete the block and add prose: with the exemption on
    // both sides the deleted table is worth nothing, so the added prose is growth
    // and fails. With the exemption on the working side only, the base still
    // carries the table and those words are free to spend here.
    const spent = `${say("intro", 20)}\n\n${say("outro", 10)}\n\n${say("new", 5)}`;
    const report = checkDoc(prose, spent);
    expect(report.oldTotal).toBe(proseOnly);
    expect(report.total).toBe(proseOnly + 5);
    expect(report.stderr).toContain("Total:");
    expect(report.status).toBe(1);
  });

  it("counts the whole file when a BEGIN has no END", () => {
    // Fails toward counting: a truncated or hand-edited marker is noise somebody
    // fixes, where skipping to end of file is one line's mistake buying unlimited
    // headroom, silently. Same direction, same reason, as
    // lib/__tests__/strip-comments.ts states for its own scanner.
    const truncated = `${say("intro", 20)}\n\n${BEGIN}\n${say("row", 100)}`;
    const report = checkDoc(prose, truncated);
    expect(report.total).toBe(raw(truncated));
    expect(report.status).toBe(1);
  });
});

describe("withoutGeneratedBlocks", () => {
  it("skips every pair in a file and keeps the prose between them", () => {
    // No file has two blocks today. That is the reason for a test rather than an
    // assumption: the second one is written by someone who will not read this.
    const doc = [
      say("head", 3),
      block(50),
      say("middle", 4),
      `<!-- BEGIN GENERATED: another index -->\n${say("row", 50)}\n<!-- END GENERATED: another index -->`,
      say("tail", 5),
    ].join("\n\n");
    expect(words(doc)).toBe(3 + 4 + 5);
    expect(withoutGeneratedBlocks(doc)).toContain("middle0");
    expect(withoutGeneratedBlocks(doc)).not.toContain("row0");
  });

  it("is by marker, not by filename or label", () => {
    const doc = `${say("head", 2)}\n<!-- BEGIN GENERATED: anything at all -->\n${say("row", 9)}\n<!-- END GENERATED: anything at all -->`;
    expect(words(doc)).toBe(2);
  });

  it("counts an END with no BEGIN, and text after an unmatched BEGIN", () => {
    expect(words(`${say("a", 3)}\n${END}\n${say("b", 4)}`)).toBe(
      raw(`${say("a", 3)}\n${END}\n${say("b", 4)}`)
    );
    const open = `${say("a", 3)}\n${BEGIN}\n${say("b", 4)}`;
    expect(words(open)).toBe(raw(open));
  });

  it("does not treat a marker mangled across lines as a fence", () => {
    // `[^\n]` in the pattern: a broken comment must not fence off everything up to
    // the next `-->` anywhere below it.
    const doc = `${say("a", 3)}\n<!-- BEGIN GENERATED:\ntime-column index -->\n${say("b", 4)}\n${END}\n${say("c", 2)}`;
    expect(words(doc)).toBe(raw(doc));
  });

  it("leaves a file with no markers exactly as it counted before", () => {
    const doc = `${say("a", 12)}\n\n${say("b", 8)}`;
    expect(words(doc)).toBe(raw(doc));
    expect(withoutGeneratedBlocks(doc)).toBe(doc);
  });
});

describe("the doc the exemption was ruled for", () => {
  const doc = fs.readFileSync(
    path.join(REPO, "docs/internals/time-columns.md"),
    "utf8"
  );

  it("is mostly a generated table, and counts only its prose", () => {
    expect(doc).toContain(BEGIN); // otherwise every expectation here is vacuous
    expect(doc).toContain(END);
    const [before, rest] = doc.split(BEGIN);
    const after = rest.split(END)[1];
    expect(words(doc)).toBe(raw(before) + raw(after));
    expect(words(doc)).toBeLessThan(raw(doc) / 2);
  });
});
