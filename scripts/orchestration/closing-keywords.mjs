#!/usr/bin/env node
// Print every issue a PR would CLOSE on merge — body and commit messages both.
//
// WHY THIS IS A SCRIPT AND NOT A REGEX YOU TYPE.
//
// GitHub honours these closing keywords: close, closes, closed, fix, fixes,
// fixed, resolve, resolves, resolved. Typed from memory at a merge prompt, the
// natural three are `fixes|closes|resolves` — and that set is what the
// orchestrator used on every merge of 2026-08-21/22.
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
// Exit 0 = nothing closes. Exit 2 = the check could not answer. Exit 3 =
// something closes (read it before merging).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { helpGuard } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

export const EXIT = Object.freeze({
  nothingCloses: 0,
  cannotAnswer: 2,
  closes: 3,
});

export const KEYWORDS = [
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

const REPO = "FloorLamp/allos";
const MAX_BUFFER = 64 * 1024 * 1024;

function pattern() {
  return new RegExp(`\\b(${KEYWORDS.join("|")})\\s+#(\\d+)`, "gi");
}

/**
 * Every closing-keyword hit, including English negations. GitHub parses the
 * token sequence, not the sentence's intent, so "does not close #3489" is a
 * close and must be reported as one (#3660).
 */
export function closingKeywordHits(text, where) {
  if (!text) return [];
  return [...text.matchAll(pattern())].map((match) => ({
    issue: match[2],
    where,
    phrase: match[0],
  }));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class CannotAnswer extends Error {}

/**
 * The curl fallback for hosts without `gh`.
 *
 * Returns parsed JSON, or `undefined` when curl itself is unavailable or the
 * request failed — never a reassuring empty value. `undefined` sends the caller
 * back to the CannotAnswer it would otherwise have thrown, so a failure here
 * cannot be mistaken for "nothing closes".
 *
 * A paginated read returns the `--slurp` shape — an ARRAY OF PAGES — walked
 * until a short page. A truncated read would understate what a merge closes, so
 * an incomplete walk returns undefined rather than the pages gathered so far.
 */
function curlOnce(url) {
  const run = spawnSync(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      "-H",
      "Accept: application/vnd.github+json",
      url,
    ],
    {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (run.error || run.status !== 0) return undefined;
  let json;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
  if (isRecord(json) && typeof json.message === "string") return undefined;
  return json;
}

function curlApi(endpoint, { paginate = false } = {}) {
  const base = `https://api.github.com/${endpoint.replace(/^\/+/, "")}`;
  if (!paginate) return curlOnce(base);

  const perPage = Number(/[?&]per_page=(\d+)/.exec(base)?.[1] ?? 30);
  const join = base.includes("?") ? "&" : "?";
  const pages = [];
  // Bounded so a malformed link cycle cannot spin: 100 pages of 100 is far more
  // commits than any reviewable PR carries, and hitting the cap returns
  // undefined rather than a partial answer.
  for (let page = 1; page <= 100; page += 1) {
    const body = curlOnce(`${base}${join}page=${page}`);
    if (!Array.isArray(body)) return undefined;
    pages.push(body);
    if (body.length < perPage) return pages;
  }
  return undefined;
}

/**
 * Read one GitHub API endpoint through the authenticated CLI.
 *
 * No token is passed on argv, printed, or written. `gh` resolves its supported
 * authentication sources itself, including a credential-store-only login. The
 * caller receives parsed JSON or a controlled failure; it never receives a
 * reassuring empty value from an auth/API/parse error.
 */
function ghApi(endpoint, { paginate = false } = {}) {
  const args = ["api", "--method", "GET"];
  if (paginate) args.push("--paginate", "--slurp");
  args.push(endpoint);
  const run = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // NO `gh` ON THIS HOST IS NOT THE SAME FACT AS `gh` REFUSING, and only the
  // first one earns a fallback. `run.error` means the binary could not be
  // spawned at all; a non-zero status means gh ran and said no, which is a
  // signal to respect rather than route around — the auth-failure case must
  // still fail closed, and there is a test that says so.
  // Measured 2026-08-31: `gh` is absent in Claude Code remote, so this scanner
  // could not run there AT ALL, and it is the guard that catches a `Fixes #N`
  // on an issue the diff does not finish. Exiting 2 was honest and useless.
  // Reads need no credential (public repo), and Node's fetch ignores
  // HTTPS_PROXY in that container while curl does not — the same reasoning as
  // issue-read.mjs. See docs/orchestration/environment.md §GitHub access.
  if (run.error) {
    const viaCurl = curlApi(endpoint, { paginate });
    if (viaCurl !== undefined) return viaCurl;
  }
  if (run.error) throw new CannotAnswer(`could not run gh api for ${endpoint}`);
  if (run.status !== 0)
    throw new CannotAnswer(
      `gh api failed for ${endpoint} (exit ${run.status ?? "unknown"})`
    );

  let json;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    throw new CannotAnswer(`gh api returned invalid JSON for ${endpoint}`);
  }
  if (isRecord(json) && typeof json.message === "string")
    throw new CannotAnswer(`GitHub API rejected ${endpoint}`);
  return json;
}

function pullBody(pr) {
  const endpoint = `repos/${REPO}/pulls/${pr}`;
  const pull = ghApi(endpoint);
  if (!isRecord(pull) || !(pull.body === null || typeof pull.body === "string"))
    throw new CannotAnswer(`GitHub API returned an invalid pull for #${pr}`);
  return pull.body ?? "";
}

function pullCommits(pr) {
  const endpoint = `repos/${REPO}/pulls/${pr}/commits?per_page=100`;
  const pages = ghApi(endpoint, { paginate: true });
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new CannotAnswer(
      `GitHub API returned invalid commit pages for #${pr}`
    );

  return pages.flat().map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sha !== "string" ||
      !isRecord(entry.commit) ||
      typeof entry.commit.message !== "string"
    )
      throw new CannotAnswer(
        `GitHub API returned an invalid commit for #${pr}`
      );
    return { sha: entry.sha, message: entry.commit.message };
  });
}

function issueSummary(issueNumber) {
  const endpoint = `repos/${REPO}/issues/${issueNumber}`;
  const issue = ghApi(endpoint);
  if (
    !isRecord(issue) ||
    typeof issue.state !== "string" ||
    typeof issue.title !== "string"
  )
    throw new CannotAnswer(
      `GitHub API returned an invalid issue for #${issueNumber}`
    );
  return { state: issue.state, title: issue.title };
}

export function main(argv = process.argv.slice(2)) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error("usage: closing-keywords.mjs <pr-number>");
    return EXIT.cannotAnswer;
  }

  try {
    const hits = [
      ...closingKeywordHits(pullBody(pr), "PR body"),
      ...pullCommits(pr).flatMap(({ sha, message }) =>
        closingKeywordHits(message, `commit ${sha.slice(0, 8)}`)
      ),
    ];
    const found = new Map();
    for (const hit of hits) {
      const list = found.get(hit.issue) ?? [];
      list.push(`${hit.where}: "${hit.phrase}"`);
      found.set(hit.issue, list);
    }

    if (found.size === 0) {
      console.log(`PR #${pr}: nothing closes on merge.`);
      return EXIT.nothingCloses;
    }

    // Resolve every issue before printing the result. An auth/API failure while
    // decorating the findings is still "cannot answer", never a partial success
    // that a merge operator could mistake for a complete list.
    const summaries = new Map();
    for (const issueNumber of found.keys())
      summaries.set(issueNumber, issueSummary(issueNumber));

    console.log(`PR #${pr} WOULD CLOSE ${found.size} issue(s) on merge:`);
    for (const [issueNumber, wheres] of found) {
      const issue = summaries.get(issueNumber);
      console.log(
        `  #${issueNumber} [${issue.state}] ${issue.title.slice(0, 80)}`
      );
      for (const where of wheres) console.log(`      ${where}`);
    }
    console.log(
      "\nIs each of those actually FIXED by this diff? If not, change the keyword to `Refs`."
    );
    return EXIT.closes;
  } catch (error) {
    const reason =
      error instanceof CannotAnswer
        ? error.message
        : "unexpected scanner error";
    console.error(`PR #${pr}: cannot determine closing issues: ${reason}.`);
    return EXIT.cannotAnswer;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
