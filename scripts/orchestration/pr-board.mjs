// The orchestrator's PR glance (plain Node, no deps).
//
// WHY THIS IS NOT ci-watch.mjs. That script answers "is THIS pr settled, and may
// I merge it" — a verdict about one PR, derived from two matching polls, blocking
// until it can say. This one answers a different question, the one asked twenty
// times a night: "what is the state of everything open right now, and if
// something is red, WHY". It samples once, never blocks, and issues no verdict.
// Same reason the repo keeps `getDailySleepSessionsSince` beside the stream read:
// two questions that look alike and are not.
//
// WHAT IT REPLACES, and what that cost. Both halves were hand-run all night as
// throwaway curl-plus-python pipelines:
//
//   1. The status glance. Rewritten from memory each time, which is how `$?`
//      after a pipe got read as the script's exit code twice — the pipeline
//      reports `tail`'s status, so a settled-red run was announced as green
//      until the correction. A script cannot make that mistake on your behalf.
//
//   2. The failure detail, which is the expensive one. The obvious route is the
//      job log, and it is a trap: the raw-log endpoint 302s to a blob host the
//      agent proxy refuses (curl exit 56, `CONNECT tunnel failed, 403`), and the
//      MCP log reader returns the tail of a ~1,900-line file — which on a green-
//      but-for-one-spec shard is ninety lines of artifact-upload chatter and no
//      failure at all. Two fetches, ~10k tokens, nothing learned.
//
//      The check-run ANNOTATIONS endpoint carries exactly the failing spec, its
//      assertion, and the source excerpt, in a few hundred bytes. Everything a
//      diagnosis needs and nothing else. That is the whole trick, and finding it
//      by accident after burning the context is why it is written down here.
//
// Usage:
//   node scripts/orchestration/pr-board.mjs                 # every open PR
//   node scripts/orchestration/pr-board.mjs 2634 2639       # just these
//   node scripts/orchestration/pr-board.mjs --why           # + annotations for red
//
// Exit 0 always: a glance is not a verdict. Use ci-watch.mjs for the merge gate.

import { execFileSync } from "node:child_process";

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  // The unauthenticated read returns an error body that parses to nothing, which
  // renders as "no failures" — a lie in the reassuring direction (ci-watch.mjs
  // carries the same assertion for the same reason).
  console.error(
    'BLOCKED: neither GH_TOKEN nor GITHUB_TOKEN is set. Refusing to poll — an\nunauthenticated read reads as "nothing is wrong". Re-mint with add_repo access:"push".'
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const why = args.includes("--why");
const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
const repoArg = args.indexOf("--repo");
const repo = repoArg >= 0 ? args[repoArg + 1] : "FloorLamp/allos";

function gh(pathname) {
  let out;
  try {
    out = execFileSync(
      "curl",
      [
        "-sS",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/${repo}/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (err) {
    console.error(`GET ${pathname} failed: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(out);
  } catch {
    console.error(`GET ${pathname} returned a non-JSON body`);
    return null;
  }
}

const open = gh("pulls?state=open&per_page=50");
if (!Array.isArray(open)) process.exit(3);
const prs = wanted.length
  ? open.filter((p) => wanted.includes(p.number))
  : open;
// Missing numbers are said out loud rather than silently dropped — asking about a
// merged PR and getting a clean empty board is the reassuring-lie shape again.
for (const n of wanted) {
  if (!prs.some((p) => p.number === n)) {
    console.log(`#${n} — not open (merged, closed, or wrong number)`);
  }
}

const red = [];
for (const p of prs.sort((a, b) => a.number - b.number)) {
  const runs = gh(`commits/${p.head.sha}/check-runs?per_page=100`);
  const list = runs?.check_runs ?? [];
  let ok = 0,
    pending = 0;
  const failed = [];
  for (const r of list) {
    if (r.status !== "completed") pending++;
    else if (r.conclusion === "success" || r.conclusion === "skipped") ok++;
    else failed.push(r);
  }
  const state = failed.length
    ? `RED ${failed.length}`
    : pending
      ? `run ${ok}/${list.length}`
      : list.length
        ? "GREEN"
        : "no CI";
  // mergeable is computed lazily by GitHub and is null on a cold read; say
  // "unknown" rather than implying a conflict that may not exist.
  const merge =
    p.mergeable === false
      ? " CONFLICT"
      : p.mergeable === null
        ? " (mergeable unknown)"
        : "";
  console.log(
    `#${p.number} ${p.draft ? "draft " : ""}${state.padEnd(9)} ${p.head.ref.slice(0, 34).padEnd(34)} ${p.title.slice(0, 46)}${merge}`
  );
  if (failed.length) red.push({ pr: p.number, failed });
}

if (!why || !red.length) {
  if (red.length) console.log("\n(--why prints each failure's annotation)");
  process.exit(0);
}

// The annotations, which is the part worth having.
for (const { pr, failed } of red) {
  for (const r of failed) {
    console.log(`\n=== #${pr} ${r.name} (${r.conclusion}) ===`);
    const anns = gh(`check-runs/${r.id}/annotations`);
    if (!Array.isArray(anns) || !anns.length) {
      console.log(`  (no annotations — ${r.html_url})`);
      continue;
    }
    for (const a of anns) {
      // The `.github` rows are the runner's own "exit code 1" and the summary
      // notice; the file-scoped rows carry the actual assertion. Print the
      // file-scoped ones in full and keep the summary short.
      const head = a.path && a.path !== ".github" ? a.path : "(summary)";
      const body = (a.message ?? "").trim();
      console.log(
        `  --- ${head}${a.start_line ? `:${a.start_line}` : ""} [${a.annotation_level}]`
      );
      console.log(
        body
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")
      );
    }
  }
}
