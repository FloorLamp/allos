#!/usr/bin/env node
// Check all Markdown and dispatch/brief sources against a word budget.
// Usage: node scripts/check-doc-brevity.mjs [--base <git-ref>]
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: npm run docs:check -- [--base <git-ref>]\nNew/short files: 1500 words. Oversized files and the total: no growth from the base."
  );
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== "--base")) {
  console.error("Usage: npm run docs:check -- [--base <git-ref>]");
  process.exit(1);
}
const git = (...argv) =>
  execFileSync("git", argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
const words = (text) => text.match(/\S+/g)?.length ?? 0;
const covered = (name) =>
  /\.md$/i.test(name) ||
  /^scripts\/.*(?:dispatch|brief)[^/]*\.(?:[cm]?js|tsx?)$/i.test(name);

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
