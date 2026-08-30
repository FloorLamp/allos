#!/usr/bin/env node
// Read a tracker item WHOLE, and surface rulings that a truncated read would miss.
//
// Owner rulings are APPENDED to the end of an issue body. A read that stops at
// the first N characters drops exactly the binding text — measured 2026-08-30,
// when a 3200-character read of #3903 missed an owner ruling in its tail and the
// orchestrator labelled a fully-ruled P1 `needs-human`, then re-labelled #3265
// the same way minutes later. Both rulings sat in the last 900 characters.
//
// usage: issue-read.mjs <number> [number...]  [--quiet-body]

import { execFileSync } from "node:child_process";

const REPO = process.env.ALLOS_REPO ?? "FloorLamp/allos";
const API = `https://api.github.com/repos/${REPO}`;

// Reads go through curl, not fetch. Node's fetch ignores HTTPS_PROXY, and this
// container reaches api.github.com only through the agent proxy — which also
// supplies the credential, so a direct fetch 403s while curl gets 15000/hr.
// Reads need no credential of our own; see docs/orchestration/environment.md.
function get(path) {
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      "-H",
      "Accept: application/vnd.github+json",
      `${API}${path}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

// Deliberately broad: a missed ruling costs far more than a false positive.
const RULING =
  /^.*\b(owner ruling|owner call|ruled|ruling|decision|decided|verdict|cleared to merge|struck)\b.*$/gim;

function findRulings(text) {
  const out = [];
  for (const m of text.matchAll(RULING)) {
    out.push({ pos: m.index ?? 0, line: m[0].trim() });
  }
  return out;
}

function banner(ch, msg) {
  console.log(`\n${ch.repeat(78)}\n${msg}\n${ch.repeat(78)}`);
}

function readOne(n) {
  const issue = get(`/issues/${n}`);
  const comments = get(`/issues/${n}/comments?per_page=100`);
  const body = issue.body ?? "";
  const isPr = Boolean(issue.pull_request);

  banner("=", `#${n} ${isPr ? "[PR]" : "[issue]"} ${issue.title}`);
  console.log(
    `state=${issue.state}  labels=${issue.labels.map((l) => l.name).join(",") || "(none)"}`
  );
  console.log(
    `assignees=${issue.assignees.map((a) => a.login).join(",") || "(none)"}`
  );
  console.log(
    `updated=${issue.updated_at}  body=${body.length} chars  comments=${comments.length}`
  );

  // The whole point: rulings live in the TAIL, so report where they sit.
  const bodyRulings = findRulings(body);
  const tailRulings = bodyRulings.filter((r) => r.pos > body.length * 0.6);
  if (bodyRulings.length) {
    banner(
      "!",
      `RULING-SHAPED LINES IN THE BODY (${bodyRulings.length}; ${tailRulings.length} in the last 40%)`
    );
    for (const r of bodyRulings) {
      const pct = Math.round((r.pos / Math.max(body.length, 1)) * 100);
      console.log(
        `  @${String(r.pos).padStart(6)} (${String(pct).padStart(3)}% in)  ${r.line.slice(0, 150)}`
      );
    }
    if (tailRulings.length) {
      console.log(
        `\n  ^ ${tailRulings.length} of these sit past the 60% mark. A truncated read WOULD HAVE MISSED THEM.`
      );
    }
  }

  for (const c of comments) {
    const cr = findRulings(c.body ?? "");
    if (!cr.length) continue;
    banner(
      "!",
      `RULING-SHAPED LINES IN COMMENT by ${c.user.login} (${c.created_at})`
    );
    for (const r of cr) console.log(`  ${r.line.slice(0, 150)}`);
  }

  if (!process.argv.includes("--quiet-body")) {
    banner("-", "BODY (whole, untruncated)");
    console.log(body || "(empty)");
    for (const c of comments) {
      banner("-", `COMMENT by ${c.user.login} at ${c.created_at}`);
      console.log(c.body ?? "(empty)");
    }
  }

  banner(
    "=",
    `END #${n} — a comment overrides the body where they conflict; reconcile by timestamp.`
  );
}

const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!nums.length) {
  console.error("usage: issue-read.mjs <number> [number...] [--quiet-body]");
  process.exit(2);
}
for (const n of nums) readOne(n);
