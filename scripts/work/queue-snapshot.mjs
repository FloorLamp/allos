// Queue snapshot — the dispatchable queue, WRITTEN DOWN (owner, 2026-08-31).
//
// A live session with open capacity called the queue thin while four
// dispatchable items sat in it: a reconcile it never looked for, a small
// issue it never thought to pair, and self-filed issues it had mentally
// reclassified as backlog. A queue that lives in the worker's head can
// be forgotten one item at a time; one written to disk by tooling cannot. So
// this sweeps open issues and writes the candidate list to
// `$STATE_DIR/.queue`, and work-checkin.sh refreshes it whenever it
// is 4h stale — the sweep is forced on the same cadence as the catch-up
// digest, and the lanes verdict cites the file's own count.
//
// Usage:
//   node scripts/work/queue-snapshot.mjs        # sweep, write, print
//
// One line per candidate: `P2 #1234 [lane:branch] [deps:#99] title`. Excluded,
// with reasons the runbook owns: PRs, `parked` (not queue state),
// `needs-human` (owner-gated), and the reconcile watermark carrier (machine
// state). An issue with NO priority slot stays IN, marked [no-slot] — hygiene
// drift is not an excuse to forget the work. Sort: slot, free before under
// dispatch, oldest first. [deps:#N] is the raw Depends-on line, unresolved —
// judging whether a dep still blocks is the reader's job, but the marker means
// it cannot be overlooked. Read-only; exit 2 without a token (a truncated
// sweep would write a shorter queue, which lies in the idle direction).
//
// AN ISSUE UNDER ACTIVE DISPATCH IS MARKED, NEVER DROPPED (#4451). The sweep
// had no cross-reference to the dispatch ledger, so live lanes read as
// available capacity: measured on the 2026-08-31 10:22Z file, 4 of the 5
// issues in active ledger entries were listed as candidates. Dropping them
// would trade one lie for another — a dropped row is a forgotten row, which
// is the whole failure this file exists to stop — so they stay in, carry
// `[lane:<branch>]`, sort to the back of their slot, and are counted apart in
// the header the check-in prints.
//
// THERE IS NO PROVENANCE MARKER, AND THAT IS DELIBERATE (#4451). This file
// used to publish `(N self-filed)` from `/found (while|by)/i` over the body.
// That measures PHRASING. Against the only ground truth available — the 8
// still-open issues the worker filed in one session — it fired on 3 and
// missed 5, all 8 written by the same GitHub author as owner-filed work, so
// the author field cannot stand in either. A published number that is right
// 3 times in 8 is worse than no number, because the next reader quotes it.
// Provenance needs a marker written at FILING time; until one exists this
// sweep says nothing about who filed what.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { helpGuard, isMain } from "./usage.mjs";
import { resolveReadToken, resolveStateDir } from "./host.mjs";
import { laneIssues, readLedger } from "./ledger.mjs";
helpGuard(process.argv, import.meta.url);

// Literal, not an import: reconcile-tracker-core is TypeScript and this
// script runs under plain node. Equality with the core's constant is pinned
// in lib/__tests__/queue-snapshot-script.test.ts, so a rename breaks there.
const WATERMARK_TITLE = "Reconcile watermark (machine state)";
const SLOTS = ["P0", "P1", "P2", "P3"];

/** Pure: one snapshot from raw open issues. Exported for the test drive. */
export function buildSnapshot(raw, now = new Date(), lanes = new Map()) {
  const rows = [];
  for (const i of raw) {
    if (i.pull_request) continue;
    if (i.title === WATERMARK_TITLE) continue;
    const labels = (i.labels ?? []).map((l) => l.name);
    if (labels.includes("parked") || labels.includes("needs-human")) continue;
    const slot = SLOTS.find((s) => labels.includes(s)) ?? null;
    const lane = lanes.get(i.number) ?? null;
    const deps = [...(i.body ?? "").matchAll(/^Depends-on:\s*#(\d+)/gim)].map(
      (m) => `#${m[1]}`
    );
    rows.push({ number: i.number, title: i.title, slot, lane, deps });
  }
  rows.sort(
    (a, b) =>
      (a.slot ? SLOTS.indexOf(a.slot) : SLOTS.length) -
        (b.slot ? SLOTS.indexOf(b.slot) : SLOTS.length) ||
      Number(Boolean(a.lane)) - Number(Boolean(b.lane)) ||
      a.number - b.number
  );
  const laneCount = rows.filter((r) => r.lane).length;
  const lines = [
    `${rows.length} candidates as of ${now.toISOString().slice(0, 16)}Z ` +
      `(${laneCount} under dispatch) — written by queue-snapshot.mjs; a ` +
      "'thin' claim answers every line here",
    ...rows.map(
      (r) =>
        `${r.slot ?? "[no-slot]"} #${r.number}` +
        `${r.lane ? ` [lane:${r.lane}]` : ""}` +
        `${r.deps.length ? ` [deps:${r.deps.join(",")}]` : ""} ${r.title}`
    ),
  ];
  return { rows, text: lines.join("\n") + "\n" };
}

function main() {
  const token = resolveReadToken();
  if (!token) {
    console.error(
      "no GH_TOKEN/GITHUB_TOKEN and no authenticated gh — refusing: a " +
        "truncated sweep writes a SHORTER queue, which lies in the idle direction."
    );
    process.exit(2);
  }
  const repo = process.env.RECONCILE_REPO || "FloorLamp/allos";
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "--fail-with-body",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const batch = JSON.parse(out);
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch);
    if (batch.length < 100) break;
  }

  const snapshot = buildSnapshot(issues, new Date(), laneIssues(readLedger()));
  const file = path.join(resolveStateDir(), ".queue");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot.text);
  process.stdout.write(snapshot.text);
  console.error(`written to ${file}`);
}

if (isMain(process.argv, import.meta.url)) main();
