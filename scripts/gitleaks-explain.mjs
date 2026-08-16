#!/usr/bin/env node
// Says WHERE a gitleaks finding came from (#2949).
//
// `.github/workflows/gitleaks.yml` scans `--log-opts="--all"` over a
// `fetch-depth: 0` checkout. That is the right security posture — a secret
// committed anywhere in this repository's history should be found — but "--all"
// means EVERY REF PUSHED TO THE REPOSITORY, not "this branch". So a concurrent
// branch's credential-shaped test fixture fails the `gitleaks` check on every
// open PR, naming a file the PR never touched and does not even contain. Read
// without knowing that, the red says a PR introduced a credential into a file it
// never opened.
//
// The information needed to say otherwise is already in gitleaks' own output:
// every finding in the JSON report carries the COMMIT that introduced it. From
// there `git merge-base --is-ancestor` answers "is this on my branch" and
// `git for-each-ref --contains` names the ref that actually carries it.
//
// This changes NO security posture. The same findings still fail the same job;
// this only explains them. Nothing here can turn a finding into a pass — the
// workflow exits with gitleaks' own status regardless of what this prints.
//
// Dependency-free on purpose: the gitleaks job installs no node_modules, so this
// may use nothing outside node: builtins.
//
// Usage: node scripts/gitleaks-explain.mjs <report.json>
//   env GITLEAKS_BASE_REF  ref the PR merges into (default origin/main)
//   env GITLEAKS_HEAD      the scanned head (default HEAD)

import fs from "node:fs";
import { spawnSync } from "node:child_process";

// How many distinct commits to resolve refs for. `for-each-ref --contains` walks
// history per call, and a report with hundreds of findings is a different
// problem from the one this exists to explain.
export const COMMIT_LIMIT = 10;

/**
 * Which bucket a finding's commit falls into.
 *
 * - "base"      already in the base branch's history; this PR did not add it.
 * - "branch"    on this branch and not on the base; this PR added it.
 * - "elsewhere" not reachable from the scanned head at all — another ref.
 * - "unknown"   no commit on the finding (a non-git scan mode).
 */
export function classifyCommit({ onHead, onBase, commit }) {
  if (!commit) return "unknown";
  if (onBase) return "base";
  if (onHead) return "branch";
  return "elsewhere";
}

function short(commit) {
  return commit ? commit.slice(0, 10) : "(unknown)";
}

function findingLine(f) {
  const where = f.StartLine ? `:${f.StartLine}` : "";
  return `  ${f.File ?? "(unknown file)"}${where}  [${f.RuleID ?? "?"}]`;
}

/**
 * The explanation for one commit's findings. Pure — takes everything it needs.
 *
 * `info` is { commit, kind, refs, subject, date, author }.
 */
export function explainCommit(info, findings, { baseLabel }) {
  const lines = [];
  const head = `### ${
    {
      base: "Already in " + baseLabel,
      branch: "Introduced by this branch",
      elsewhere: "NOT on this branch — it came from another ref",
      unknown: "Origin commit unknown",
    }[info.kind]
  }`;
  lines.push(head, "");
  for (const f of findings) lines.push(findingLine(f));
  lines.push("");
  lines.push(`  commit: ${short(info.commit)}${info.subject ? `  ${info.subject}` : ""}`);
  if (info.author || info.date) {
    lines.push(`  by:     ${[info.author, info.date].filter(Boolean).join("  ")}`);
  }
  if (info.kind === "elsewhere" || info.refs?.length) {
    lines.push(
      `  refs:   ${info.refs?.length ? info.refs.join(", ") : "none — the commit is on no ref in this checkout"}`
    );
  }
  lines.push("");

  if (info.kind === "elsewhere") {
    lines.push(
      "Nothing in this pull request introduced this. The scan covers every ref",
      "pushed to this repository, not just this branch, so any branch that",
      "commits a credential-shaped literal fails this check on EVERY open PR.",
      "",
      "It clears when the owner of the ref above removes the literal from",
      "HISTORY — `git commit --amend` or an interactive rebase, then force-push —",
      "or when that branch is deleted.",
      "",
      "A follow-up commit that DELETES the line does NOT clear it: the scan reads",
      "commits, not branch tips, and the adding commit is still in that branch's",
      "history. Deleting the file is the fix that looks right and is not."
    );
  } else if (info.kind === "branch") {
    lines.push(
      "This is on this branch. Removing it needs a HISTORY rewrite —",
      "`git commit --amend` or an interactive rebase, then force-push.",
      "",
      "A follow-up commit that DELETES the line does NOT clear it: the scan reads",
      "commits, not branch tips, so the adding commit is still scanned."
    );
  } else if (info.kind === "base") {
    lines.push(
      `This literal is already in ${baseLabel}, so this pull request did not`,
      "introduce it and rebasing will not remove it. Clearing it means rewriting",
      "published history — raise it rather than absorbing it here."
    );
  } else {
    lines.push(
      "gitleaks reported no commit for this finding, so its origin cannot be",
      "attributed. Treat it as present in the working tree."
    );
  }
  return lines.join("\n");
}

/** The whole report. Pure. `commits` is an array of [info, findings] pairs. */
export function explainReport(commits, { baseLabel, truncated = 0 }) {
  const counts = { base: 0, branch: 0, elsewhere: 0, unknown: 0 };
  for (const [info, findings] of commits) counts[info.kind] += findings.length;

  const lines = ["## Where these gitleaks findings came from", ""];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  lines.push(
    `${total} finding${total === 1 ? "" : "s"} across ${commits.length} commit${
      commits.length === 1 ? "" : "s"
    }: ` +
      [
        counts.branch && `${counts.branch} on this branch`,
        counts.elsewhere && `${counts.elsewhere} from other refs`,
        counts.base && `${counts.base} already in ${baseLabel}`,
        counts.unknown && `${counts.unknown} unattributed`,
      ]
        .filter(Boolean)
        .join(", "),
    ""
  );
  if (counts.elsewhere && !counts.branch) {
    lines.push(
      "**No finding here is on this branch.** This check is red because of a",
      "commit on another ref; see below for which one and who can clear it.",
      ""
    );
  }
  for (const [info, findings] of commits) {
    lines.push(explainCommit(info, findings, { baseLabel }), "");
  }
  if (truncated > 0) {
    lines.push(
      `(${truncated} further commit${truncated === 1 ? "" : "s"} with findings not resolved; ` +
        `only the first ${COMMIT_LIMIT} are looked up.)`,
      ""
    );
  }
  return lines.join("\n");
}

/** GitHub workflow-command escaping for a message body. */
export function escapeAnnotation(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** GitHub workflow-command escaping for a property value (title=...). */
export function escapeAnnotationProperty(text) {
  return escapeAnnotation(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function annotationFor(info, findings, { baseLabel }) {
  const title = {
    base: `gitleaks finding is already in ${baseLabel}`,
    branch: "gitleaks finding is on this branch",
    elsewhere: `gitleaks finding is NOT on this branch (from ${
      info.refs?.[0] ?? "an unknown ref"
    })`,
    unknown: "gitleaks finding with no attributable commit",
  }[info.kind];
  return `::error title=${escapeAnnotationProperty(title)}::${escapeAnnotation(
    explainCommit(info, findings, { baseLabel })
  )}`;
}

// ---------------------------------------------------------------------------
// git plumbing — the only impure part.

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function commitInfo(commit, { head, baseRef }) {
  const onHead = git(["merge-base", "--is-ancestor", commit, head]).ok;
  const onBase = baseRef ? git(["merge-base", "--is-ancestor", commit, baseRef]).ok : false;
  const refs = git([
    "for-each-ref",
    `--contains=${commit}`,
    "--format=%(refname:short)",
    "refs/remotes/origin",
    "refs/tags",
  ]);
  const meta = git(["show", "-s", "--format=%s%n%an%n%ad", "--date=short", commit]);
  const [subject = "", author = "", date = ""] = meta.ok ? meta.out.split("\n") : [];
  return {
    commit,
    kind: classifyCommit({ onHead, onBase, commit }),
    refs: refs.ok && refs.out ? refs.out.split("\n").filter(Boolean) : [],
    subject,
    author,
    date,
  };
}

function main(argv) {
  const path = argv[2];
  if (!path || !fs.existsSync(path)) {
    console.log(`gitleaks-explain: no report at ${path ?? "(no path given)"}; nothing to explain.`);
    return;
  }
  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    console.log(`gitleaks-explain: could not read the report (${e.message}).`);
    return;
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    console.log("gitleaks-explain: the report holds no findings.");
    return;
  }

  const head = process.env.GITLEAKS_HEAD || "HEAD";
  const wantedBase = process.env.GITLEAKS_BASE_REF || "origin/main";
  // Degrade rather than mislead: without a resolvable base every finding on the
  // merge commit would read as "introduced by this branch", including ones that
  // have been in main for months.
  const baseRef = git(["rev-parse", "--verify", "--quiet", `${wantedBase}^{commit}`]).ok
    ? wantedBase
    : null;
  const baseLabel = baseRef ?? "the base branch";

  const byCommit = new Map();
  for (const f of findings) {
    const key = f.Commit || "";
    if (!byCommit.has(key)) byCommit.set(key, []);
    byCommit.get(key).push(f);
  }
  const keys = [...byCommit.keys()];
  const resolved = keys.slice(0, COMMIT_LIMIT).map((commit) => {
    const info = commit
      ? commitInfo(commit, { head, baseRef })
      : { commit: "", kind: "unknown", refs: [], subject: "", author: "", date: "" };
    return [info, byCommit.get(commit)];
  });

  const report = explainReport(resolved, {
    baseLabel,
    truncated: Math.max(0, keys.length - COMMIT_LIMIT),
  });
  console.log(report);
  for (const [info, group] of resolved) {
    console.log(annotationFor(info, group, { baseLabel }));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    } catch {
      // A summary that cannot be written is not worth failing over; the same
      // text already went to stdout.
    }
  }
}

// `node scripts/gitleaks-explain.mjs` runs; `import` from a test does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv);
  } catch (e) {
    // This explains a failure; it must never BE one, and must never mask the
    // finding that brought it here. The workflow exits with gitleaks' status.
    console.log(`gitleaks-explain: could not explain these findings (${e.message}).`);
  }
}
