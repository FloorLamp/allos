// Release-notes gathering (plain Node, no deps). The CURATION is prose and
// stays human; the GATHERING — which PRs merged since the newest entry, which
// are probably internal — is bookkeeping that was done by hand and therefore
// deferred (~50 PRs uncovered at the point this was written).
//
// Usage:
//   node scripts/orchestration/release-notes-gather.mjs [--since YYYY-MM-DD]
//
// Default --since is the newest day in lib/release-notes.json, INCLUSIVE —
// same-day merges after that batch shipped would otherwise be dropped, so the
// output also prints that day's existing entry titles for an overlap check by
// eye. Reads main's squash-merge subjects (every merge is a squash whose
// subject ends "(#N)"), so one commits-API sweep covers everything.
//
// The [internal?] marker is a HEURISTIC, stated as one — it flags titles that
// look like spec/CI/docs/bookkeeping work (the classes the release-notes rules
// omit). The curator overrules it in both directions; it exists to make the
// common case a skim instead of fifty PR lookups.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error(
    'GH_TOKEN/GITHUB_TOKEN missing — cannot read main\'s history. Re-mint via add_repo access:"push".'
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const sinceFlag = args.indexOf("--since");
const notes = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "lib/release-notes.json"), "utf8")
);
const newestDay = notes.days?.[0];
const since = sinceFlag !== -1 ? args[sinceFlag + 1] : newestDay?.date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
  console.error(
    "could not determine a since-date — pass --since YYYY-MM-DD (lib/release-notes.json has no days?)"
  );
  process.exit(2);
}

const INTERNAL_GUESS = [
  /^(test|chore|docs|ci|build)\b/i,
  /^Runbook\b/i,
  /^Release notes\b/i,
  /^Bump /,
  /\b(runbook|orchestrat|e2e|flake|shard|worktree|dispatch)\b/i,
];

function gh(pathname) {
  return JSON.parse(
    execFileSync(
      "curl",
      [
        "-sS",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/FloorLamp/allos/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    )
  );
}

const merged = [];
const seen = new Set();
for (let page = 1; page <= 10; page++) {
  const commits = gh(
    `commits?sha=main&since=${since}T00:00:00Z&per_page=100&page=${page}`
  );
  if (!Array.isArray(commits)) {
    console.error(
      `unexpected commits response: ${JSON.stringify(commits).slice(0, 200)}`
    );
    process.exit(2);
  }
  for (const c of commits) {
    const subject = c.commit.message.split("\n")[0];
    const m = /^(.*) \(#(\d+)\)$/.exec(subject);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    merged.push({
      n: Number(m[2]),
      title: m[1],
      date: c.commit.committer.date.slice(0, 10),
      internal: INTERNAL_GUESS.some((re) => re.test(m[1])),
    });
  }
  if (commits.length < 100) break;
}
merged.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);

const candidates = merged.filter((p) => !p.internal);
console.log(
  `${merged.length} PRs merged to main since ${since} (inclusive) — ` +
    `${candidates.length} release-note candidates, ${merged.length - candidates.length} guessed internal.\n`
);
let day = "";
for (const p of merged) {
  if (p.date !== day) {
    day = p.date;
    console.log(`### ${day}`);
  }
  console.log(`  #${p.n}  ${p.title}${p.internal ? "  [internal?]" : ""}`);
}
if (newestDay && since === newestDay.date) {
  console.log(
    `\nOverlap check — ${newestDay.date} already has ${newestDay.entries.length} entries:`
  );
  for (const e of newestDay.entries) console.log(`  covered: ${e.title}`);
}
console.log(
  `\nCuration stays yours (docs/orchestration.md, Release notes): at most two
batches/day, ONE concise bullet per change (the title is the whole entry — the
validator refuses bodies), upgrade actions in the day's operatorNotes, internal
merges omitted. The [internal?] marker is a guess — overrule it in both
directions.`
);
