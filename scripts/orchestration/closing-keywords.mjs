#!/usr/bin/env node
// Print every issue a PR would CLOSE on merge — body and commit messages both.
//
// WHY THIS IS A SCRIPT AND NOT A REGEX YOU TYPE.
//
// GitHub honours TEN closing keywords: close, closes, closed, fix, fixes,
// fixed, resolve, resolves, resolved (and "resolve" alone). Typed from memory
// at a merge prompt, the natural three are `fixes|closes|resolves` — and that
// set is what the orchestrator used on every merge of 2026-08-21/22.
//
// It cost a real issue. PR #3529's body said "closed #3486". The check printed
// nothing, the merge went through, and #3486 — explicitly unfinished, with
// three open parts — was closed by GitHub one minute before the owner
// commented listing what was still open on it.
//
// The failure direction is what makes it worth a file: a missing keyword reads
// as "no closing keywords, safe to merge". A check that fails toward the
// reassuring answer is the one that gets trusted, which is the whole lesson of
// docs/orchestration/review-merge.md.
//
// Usage:  node scripts/orchestration/closing-keywords.mjs <pr-number>
// Exit 0 = nothing closes. Exit 3 = something closes (read it before merging).

const KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];
const PATTERN = new RegExp(`\\b(${KEYWORDS.join("|")})\\s+#(\\d+)`, "gi");

const pr = process.argv[2];
if (!pr) {
  console.error("usage: closing-keywords.mjs <pr-number>");
  process.exit(2);
}

const REPO = "FloorLamp/allos";

// SHELLS OUT TO curl, DELIBERATELY. Node's fetch does not pick up this
// environment's HTTPS proxy, so it 403s where the same request through curl
// succeeds. Reads need no credential; none is sent.
import { execFileSync } from "node:child_process";

function get(path) {
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "-H",
      "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${REPO}${path}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  let json;
  try {
    json = JSON.parse(out);
  } catch {
    console.error(`GET ${path}: unparseable response`);
    process.exit(2);
  }
  if (json && json.message && !Array.isArray(json)) {
    console.error(`GET ${path} -> ${json.message}`);
    process.exit(2);
  }
  return json;
}

const found = new Map(); // issue -> [where]
function scan(text, where) {
  if (!text) return;
  for (const m of text.matchAll(PATTERN)) {
    const n = m[2];
    if (!found.has(n)) found.set(n, []);
    found.get(n).push(`${where}: "${m[0]}"`);
  }
}

const pull = get(`/pulls/${pr}`);
scan(pull.body, "PR body");
const commits = get(`/pulls/${pr}/commits?per_page=100`);
for (const c of commits) scan(c.commit.message, `commit ${c.sha.slice(0, 8)}`);

if (found.size === 0) {
  console.log(`PR #${pr}: nothing closes on merge.`);
  process.exit(0);
}

console.log(`PR #${pr} WOULD CLOSE ${found.size} issue(s) on merge:`);
for (const [n, wheres] of found) {
  const issue = get(`/issues/${n}`);
  console.log(`  #${n} [${issue.state}] ${issue.title.slice(0, 80)}`);
  for (const w of wheres) console.log(`      ${w}`);
}
console.log(
  "\nIs each of those actually FIXED by this diff? If not, change the keyword to `Refs`."
);
process.exit(3);
