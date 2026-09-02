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

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
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

// What already SHIPPED for this item, asked of main rather than of the API:
// the search endpoint 403s through this container's proxy credential, and a
// merge to main is the stronger claim anyway — a PR can name an item without
// landing. Empty on a shallow clone, which is why the caller says so.
function mergedOnMain(n) {
  try {
    return execFileSync(
      "git",
      ["log", "origin/main", "--oneline", `--grep=${n}`, "--max-count=20"],
      { encoding: "utf8", cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
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

// A CLAIM THAT SPANS TWO ITEMS NEEDS A READ THAT SPANS TWO ITEMS (#3365, 2026-09-02).
//
// This tool already reconciles one item's body against its own comments. It could
// not see the failure that actually happened: an unparking comment on #3365 cited
// #4076's BODY rulings as the thing that unblocked the remainder, while #4076's
// NEWEST COMMENT — posted three and a half hours earlier — said the conversion had
// already shipped. A lane was dispatched to rebuild code that had been on main for
// three days. It is the body-vs-comment trap one level up: the stale note and the
// live record sat on DIFFERENT items, so reconciling either item alone was
// perfectly consistent.
//
// So whenever an item's text leans on another item, print that item's state and the
// date of its newest comment. Not the content — that would bury the read — just
// enough that "waits on #N" cannot be believed without seeing whether #N has moved.
const CROSS_REF =
  /(?:waits? on|blocked (?:by|on)|depends? on|dependent on|gated (?:by|on)|tracked in|sequences? on|deferred to)\s+#(\d+)/gi;

function crossRefNotes(text, self) {
  const seen = new Set();
  for (const m of text.matchAll(CROSS_REF)) {
    const n = Number(m[1]);
    if (n !== self) seen.add(n);
  }
  const notes = [];
  for (const n of [...seen].slice(0, 8)) {
    let other;
    try {
      other = get(`/issues/${n}`);
    } catch {
      notes.push(`  #${n} — could not read`);
      continue;
    }
    let newest = null;
    try {
      const cs = get(`/issues/${n}/comments?per_page=100`);
      newest = cs.length ? cs[cs.length - 1] : null;
    } catch {
      // comments unreadable; the state line is still worth printing
    }
    const state = `${other.state}${other.state_reason ? `/${other.state_reason}` : ""}`;
    notes.push(
      `  #${n} ${state} — body updated ${other.updated_at}` +
        (newest
          ? `, NEWEST COMMENT ${newest.created_at} by ${newest.user.login}`
          : `, no comments`)
    );
  }
  return notes;
}

function readOne(n) {
  const issue = get(`/issues/${n}`);
  const comments = get(`/issues/${n}/comments?per_page=100`);
  const body = issue.body ?? "";
  const isPr = Boolean(issue.pull_request);

  banner("=", `#${n} ${isPr ? "[PR]" : "[issue]"} ${issue.title}`);
  // Other sessions work this same tracker. An item closed since the brief was
  // written is dispatched work already done: measured 2026-08-30, when #4127 was
  // filed, dispatched, and then closed by another session's PR while the lane was
  // still running. The state line below prints it either way; a closed item shouts.
  if (issue.state !== "open") {
    banner(
      "!",
      `THIS ITEM IS ${issue.state.toUpperCase()}` +
        `${issue.state_reason ? ` (${issue.state_reason})` : ""} — closed ${issue.closed_at}.\n` +
        `Do not dispatch against it. If a lane is already running on it, STOP that lane and\n` +
        `diff its work against what actually shipped before spending anything more.`
    );
  }
  console.log(
    `state=${issue.state}  labels=${issue.labels.map((l) => l.name).join(",") || "(none)"}`
  );
  console.log(
    `assignees=${issue.assignees.map((a) => a.login).join(",") || "(none)"}`
  );
  console.log(
    `updated=${issue.updated_at}  body=${body.length} chars  comments=${comments.length}`
  );

  // THE BODY CAN BE NEWER THAN EVERY COMMENT, and nothing in the print order
  // says so — the body prints first and the comments after, which reads as
  // chronological and is not. Measured 2026-08-30 on #4076: a comment at 10:26
  // said the item was DEFERRED and must not be dispatched; the owner ruling
  // that cleared it was written into the BODY at 10:51, and `needs-human` came
  // off in the same edit. The deferral was carried for twelve hours because the
  // later fact was printed first and undated.
  //
  // The API exposes no body-edited timestamp, so this compares the issue's own
  // `updated_at` against the newest comment. Label and title edits move it too,
  // which is why this says MAY rather than DOES.
  const newestComment = comments.reduce(
    (acc, c) => (c.updated_at > acc ? c.updated_at : acc),
    ""
  );
  if (comments.length && issue.updated_at > newestComment) {
    banner(
      "!",
      `THE ITEM CHANGED AFTER ITS NEWEST COMMENT (item ${issue.updated_at} > comment ${newestComment}).\n` +
        `The BODY may carry a ruling NEWER than every comment below it — including a comment\n` +
        `saying this is deferred, blocked, or must not be dispatched. Check the body's own\n` +
        `ruling dates before trusting any comment that withholds dispatch. Labels moved too:\n` +
        `a needs-human that is GONE is itself evidence the question was answered.`
    );
  }

  // AN OPEN ITEM CAN STILL BE MOSTLY SHIPPED, and the closed-item banner above
  // cannot see that. #3366 stayed open on one unmet acceptance line while BOTH
  // of its dispatchable halves had merged in #4083 sixteen hours earlier —
  // dispatched anyway, because the issue body still described the work as
  // pending. The merged PRs that name an item are the cheapest available answer
  // to "how much of this is already done", and the orchestrator's own release
  // notes had carried one of them that morning.
  if (!isPr) {
    const merged = mergedOnMain(n);
    if (merged.length) {
      banner(
        "!",
        `${merged.length} COMMIT(S) ON main MENTION ${n} — premise-audit before dispatching.\n` +
          `An OPEN item can still be mostly shipped; read these before briefing a lane.\n` +
          merged.map((line) => `  ${line}`).join("\n")
      );
    }
  }

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

  const xrefs = crossRefNotes(
    body + "\n" + comments.map((c) => c.body ?? "").join("\n"),
    n
  );
  if (xrefs.length) {
    banner(
      "!",
      `THIS ITEM LEANS ON ${xrefs.length} OTHER ITEM(S). A claim about #N is only as fresh\n` +
        `as #N's NEWEST COMMENT — read it before believing "waits on", "deferred to" or\n` +
        `"tracked in". Measured 2026-09-02: a lane was dispatched to rebuild code that had\n` +
        `shipped three days earlier, because the unblocking ruling was read from one item's\n` +
        `body while another item's newest comment already said it was done.`
    );
    for (const line of xrefs) console.log(line);
  }

  banner(
    "=",
    `END #${n} — reconcile by TIMESTAMP, never by print order. A comment usually\n` +
      `overrides the body, but the body is edited in place and can be newer than every\n` +
      `comment here — the ruling that unblocks an item is often the last thing written.`
  );
}

const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!nums.length) {
  console.error("usage: issue-read.mjs <number> [number...] [--quiet-body]");
  process.exit(2);
}
for (const n of nums) readOne(n);
