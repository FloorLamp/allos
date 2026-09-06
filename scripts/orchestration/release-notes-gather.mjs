// Release-notes gathering (plain Node, no deps). The CURATION is prose and
// stays human; the GATHERING — which PRs merged since the newest entry, which
// are probably internal — is bookkeeping that was done by hand and therefore
// deferred (~50 PRs uncovered at the point this was written).
//
// Usage:
//   node scripts/orchestration/release-notes-gather.mjs [--since YYYY-MM-DD]
//   node scripts/orchestration/release-notes-gather.mjs --check
//
// --check prints ONE line — how many user-visible-looking merges the notes
// have not covered — and always exits 0. It exists for pm-digest.sh:
// the batch used to fall behind silently (#4077 caught four uncovered merges
// by hand), and a lag nobody is shown is a lag nobody closes.
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
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const token = resolveReadToken();
if (!token) {
  console.error(
    "no GH_TOKEN/GITHUB_TOKEN and no authenticated gh — cannot read main's " +
      'history. Re-mint via add_repo access:"push".'
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const check = args.includes("--check");
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
  // The batch's own squash, in BOTH subjects main's history now carries:
  // `Release notes: the 2026-09-03 batch, …` merged before #4983's title
  // rule, `Add the release notes for 2026-09-03` after it. Anchored on
  // purpose — a bare /release notes/ would swallow a genuinely user-visible
  // PR about the in-app notes surface (lib/release-notes.ts, /whats-new).
  /^Release notes\b/i,
  /^Add (the )?release notes\b/i,
  /^Bump /,
  // `orchestrat` stays for commit messages written before the 2026-09 rename.
  /\b(runbook|orchestrat|e2e|flake|shard|worktree|dispatch)\b/i,
  /\b(merge-gate|watermark|reconcil\w*|taxonomy|brevity|catch-up digest)\b/i,
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

// `batch.length < 100` is the exhaustion signal, and a bare `break` threw it
// away — so a clipped sweep and a complete one printed the same counts. This one
// takes the FLOOR shape rather than the refusal: the list is WINDOWED (`since`),
// a shortened list is still readable, and `--check` is a pm-digest line that must
// keep exiting 0. What it could not survive is silence, because the API returns
// commits NEWEST FIRST: the merges a clipped fetch drops are the OLDEST ones,
// which are exactly the ones most overdue for notes. `coverageSince` is the
// oldest commit day actually read — the true lower edge of the window, printed
// beside every count derived from it.
const COMMIT_PAGE_CAP = 10;
const merged = [];
const seen = new Set();
let truncated = true;
let coverageSince = null;
for (let page = 1; page <= COMMIT_PAGE_CAP; page++) {
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
  if (commits.length) coverageSince = commits.at(-1).commit.committer.date;
  if (commits.length < 100) {
    truncated = false;
    break;
  }
}
merged.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);

/** The sentence every count above is a floor of. Empty when the fetch finished. */
const boundary = truncated
  ? ` — FLOOR, not a total: the commit fetch stopped at its ${COMMIT_PAGE_CAP}-page cap` +
    ` at ${coverageSince}, so nothing merged between ${since} and that instant was read`
  : "";

const candidates = merged.filter((p) => !p.internal);

if (check) {
  // Covered = named by ANY day's entries — a same-day batch that already
  // shipped must not re-flag its own PRs.
  const covered = new Set(
    (notes.days ?? []).flatMap((d) => d.entries.map((e) => e.pr))
  );
  const uncovered = candidates.filter((p) => !covered.has(p.n));
  console.log(
    uncovered.length
      ? `release notes: ${uncovered.length} user-visible-looking merge(s) ` +
          `uncovered since ${since} (#${uncovered.map((p) => p.n).join(", #")}) ` +
          "— batch them (dispatch.md §Release notes); the [internal?] guess " +
          `may excuse some${boundary}`
      : // "current through" is the one claim a clipped fetch must never make: it
        // is read as the lag being closed, and the unread part of the window is
        // where the lag lives.
        `release notes: ${truncated ? `nothing uncovered in what was read${boundary}` : `current through ${since}`}`
  );
  process.exit(0);
}

console.log(
  `${merged.length} PRs merged to main since ${since} (inclusive) — ` +
    `${candidates.length} release-note candidates, ${merged.length - candidates.length} guessed internal.${boundary}\n`
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
  `\nCuration stays yours (docs/orchestration/dispatch.md, Release notes): at most two
batches/day, ONE concise bullet per change (the title is the whole entry — the
validator refuses bodies), upgrade actions in the day's operatorNotes, internal
merges omitted. The [internal?] marker is a guess — overrule it in both
directions.`
);
