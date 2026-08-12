// Adversarial-review lane: verdict + refuter brief (plain Node, no deps).
//
// The best defect detector this repo has is post-merge: #2444 (a shipped
// migration whose FK-guard was silently dead) was caught by a scheduled review
// of already-landed commits, and by nothing else — not the authoring agent, not
// the pre-merge review, not CI. The pre-merge review verifies a diff against
// its own claims, by the same orchestrator that wrote the brief, from the same
// model family: a single non-adversarial lane. This script is the second lane
// for the diffs where a miss corrupts data or crosses an auth boundary — a
// SEPARATE agent, prompted to REFUTE the PR's claims rather than summarize
// them, before the merge instead of 24 hours after it.
//
// Usage:
//   node scripts/orchestration/adversarial-review-brief.mjs <pr-number> [--check]
//
// Default: prints MANDATORY/optional (with the matched files) to stderr and, if
// any high-stakes path matched (or --force), the full refuter brief to stdout —
// paste it verbatim as the refuter agent's prompt.
// --check: verdict only. Exit 0 = high-stakes (lane MANDATORY), 1 = not.
//
// The high-stakes list is DECLARED HERE and nowhere else (the runbook points at
// this file). Membership rule: a path is high-stakes when a plausible bug in it
// corrupts stored data, crosses the login/profile authorization boundary, or
// silently disables a safety signal — not merely when it is important.

import { execFileSync } from "node:child_process";

const HIGH_STAKES = [
  // Corrupts every database if wrong; runs unattended at boot.
  {
    glob: /^lib\/migrations\//,
    why: "migration runner/versions — a bug corrupts every database at boot",
  },
  { glob: /^lib\/db\.ts$/, why: "connection + boot orchestration" },
  // The authorization boundary.
  {
    glob: /^lib\/auth\.ts$/,
    why: "sessions and access checks — the login/profile boundary",
  },
  { glob: /^lib\/password\.ts$/, why: "credential hashing" },
  { glob: /^middleware\.ts$/, why: "the Edge cookie gate" },
  {
    glob: /^lib\/public-paths\.ts$/,
    why: "the session-free route list — one entry too many is an open door",
  },
  // Last-line-of-defense data safety.
  {
    glob: /^lib\/backup/,
    why: "backup path — failures here are silent until the day they are everything",
  },
  {
    glob: /^lib\/restore\.ts$/,
    why: "restore path — overwrites the live database",
  },
  {
    glob: /^scripts\/(backup|restore)\.ts$/,
    why: "operator backup/restore CLIs",
  },
  // The safety-signal tier: dose reminders and escalations must never be
  // silently disabled (findings doctrine: their justification is not effectiveness).
  {
    glob: /^lib\/notifications\//,
    why: "send/suppression machinery — a bug here silences a safety signal",
  },
  {
    glob: /^lib\/nudge-cadence\.ts$/,
    why: "the send/freeze decision every safety planner rides",
  },
  // Writes replayed later with captured state.
  {
    glob: /^lib\/offline\//,
    why: "offline queue/replay — writes applied later, out of their original context",
  },
];

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const args = process.argv.slice(2);
const prNumber = args.find((a) => /^\d+$/.test(a));
const checkOnly = args.includes("--check");
const force = args.includes("--force");
if (!prNumber || !token) {
  console.error(
    !prNumber
      ? "usage: adversarial-review-brief.mjs <pr-number> [--check] [--force]"
      : 'GH_TOKEN/GITHUB_TOKEN missing — cannot read the PR. Re-mint via add_repo access:"push".'
  );
  process.exit(2);
}

// A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER. `--check` exits 1 for "not
// high-stakes", which is the code a caller reads as "skip the lane" — so any
// failure that also exits 1 is indistinguishable from a clean no, and the lane
// silently stops covering the diffs it exists for. That is the #2444 shape this
// whole script was written against: a guard that looks like a guard and answers
// no when it cannot answer at all.
//
// So every way this can fail to KNOW exits 2, joining the missing-token case
// above: a curl that cannot run, a body that is not JSON, an error object where
// a list belongs (a deleted or mistyped PR number returns `{"message":"Not
// Found"}`, on which `.map` throws). Unreachable, unparseable and unauthorized
// are all "ask again", never "carry on".
function fail(what) {
  console.error(
    `adversarial-review-brief: ${what} — cannot decide, so not deciding.`
  );
  process.exit(2);
}

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
        `https://api.github.com/repos/FloorLamp/allos/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
  } catch (err) {
    fail(`GET ${pathname} failed (${err.message})`);
  }
  try {
    return JSON.parse(out);
  } catch {
    fail(`GET ${pathname} returned a non-JSON body`);
  }
}

const pr = gh(`pulls/${prNumber}`);
if (!pr || typeof pr.number !== "number") {
  fail(
    `PR #${prNumber} did not resolve (${pr?.message ?? "no number in the response"})`
  );
}
const files = [];
for (let page = 1; page <= 10; page++) {
  const batch = gh(`pulls/${prNumber}/files?per_page=100&page=${page}`);
  if (!Array.isArray(batch)) {
    fail(
      `the file list for PR #${prNumber} came back as ${batch?.message ?? typeof batch}`
    );
  }
  files.push(...batch.map((f) => f.filename));
  if (batch.length < 100) break;
}

const hits = [];
for (const f of files) {
  const rule = HIGH_STAKES.find((r) => r.glob.test(f));
  if (rule) hits.push({ file: f, why: rule.why });
}

if (hits.length) {
  console.error(`MANDATORY — high-stakes paths in PR #${prNumber}:`);
  for (const h of hits) console.error(`  ${h.file}  (${h.why})`);
} else {
  console.error(
    `not high-stakes — no declared path matched in PR #${prNumber} (${files.length} files).`
  );
}
if (checkOnly) process.exit(hits.length ? 0 : 1);
if (!hits.length && !force) process.exit(1);

// ---- the refuter brief ------------------------------------------------------

const body =
  (pr.body ?? "").trim() ||
  "(the PR has no body — its commits' messages carry the claims)";

console.log(`You are the ADVERSARIAL REVIEWER for FloorLamp/allos PR #${prNumber}
("${pr.title}"). You are a second, independent lane — the ordinary review
already happened. Your ONLY job is to try to BREAK this change. You do not
summarize it, you do not praise it, and you do not trust its tests: a test the
author wrote proves the author's model of the bug, not the absence of others.

This diff touches paths where a miss corrupts stored data, crosses the
login/profile authorization boundary, or silences a safety signal:
${hits.map((h) => `- ${h.file} — ${h.why}`).join("\n")}

THE CLAIMS TO ATTACK (the PR body, verbatim — every factual claim in it is a
target; a claim you cannot refute after honestly trying is CONFIRMED):
---
${body}
---

METHOD
- Read-only posture: work in a fresh worktree at the PR's MERGE ref
  (git fetch origin pull/${prNumber}/merge && git worktree add $SCRATCH/wt-refute-${prNumber} FETCH_HEAD).
  You never push to this branch and never open a PR; your deliverable is a report.
- For each claim: construct the CONCRETE input, database state, or call sequence
  that would falsify it, and run it (db tier / pure tier / a scratch script
  against an in-memory database). "I read the code and it looks right" is not a
  verdict — either you executed an attack or you say the attack you could not
  build and why.
- Attack the boundaries the diff's own tests skip: the state that exists on a
  REAL upgraded database but not in a fresh fixture; the second concurrent
  writer; the rolled-back build meeting the new schema; the row a sweep or
  cleanup path must not orphan; the caller that reaches a core WITHOUT the new
  guard (grep for every caller — the calling surface is not evidence).
- Migration diffs specifically: idempotency under re-run, the parallel-boot-worker
  race, order divergence, every historical schema shape the probe claims to
  handle (a probe that cannot tell 'predates the table' from 'typo' is the #2444
  defect), and what a HALF-APPLIED failure leaves behind.
- Auth/notification diffs specifically: the unauthorized POST straight to the
  action, the profile id swapped for an accessible-but-wrong one, and the safety
  signal (dose reminder, missed-dose escalation) that a new suppression path
  could reach — those must be shown unreachable, not assumed.

REPORT (your final message, nothing else):
- Per claim: CONFIRMED (with what you ran) or REFUTED (with the exact failing
  input/sequence and its output, reproducible by the orchestrator).
- Any defect found OUTSIDE the claims, same evidence standard.
- The attacks you could not build, and what would be needed to run them.
- No verdict inflation: if everything held, say so plainly — a clean report
  after honest attack is the lane working, not a wasted dispatch.`);
