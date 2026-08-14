#!/usr/bin/env node
// How many full e2e matrices has a given spec survived, and where did it fail?
//
// WHY THIS EXISTS. When a flake fix ships, the only way to confirm it is that the
// flake stops happening — and "it hasn't come back" is not a measurement without a
// DENOMINATOR. A 1-in-6 flake is silent across five clean runs about 40% of the
// time, so a handful of green matrices proves nothing and reads like proof. This
// prints the count of exposures alongside the count of failures, and says outright
// how often that many clean runs would happen by chance if nothing had changed.
//
// It lives in the repo rather than in a scratch directory for the same reason
// `orchestrator-checkin.sh` does: an experiment that spans days cannot have its
// instrument deleted by a container restart.
//
// WHAT COUNTS AS AN EXPOSURE. Only a run where all twelve `e2e (N)` shards reached
// a verdict. A matrix that was cancelled, superseded by a newer push, or skipped is
// not a trial, and counting it would dilute the denominator in the direction that
// flatters the fix.
//
// Usage:
//   node scripts/flake-census.mjs <spec-substring> [sinceISO]
//   node scripts/flake-census.mjs overlay-gestures 2026-08-14T07:54:00Z

import { execFileSync } from "node:child_process";

const OWNER = "FloorLamp";
const REPO = "allos";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
/** The pre-fix per-matrix failure rate a clean streak is being judged against. */
const BASELINE_RATE = 1 / 6;
/** Below this, a clean streak stops being something chance explains comfortably. */
const SIGNAL_P = 0.05;

const [needle, since] = process.argv.slice(2);
if (!needle) {
  console.error(
    "usage: node scripts/flake-census.mjs <spec-substring> [sinceISO]"
  );
  process.exit(2);
}
if (!TOKEN) {
  console.error("GH_TOKEN (or GITHUB_TOKEN) must be set.");
  process.exit(2);
}

// curl, not fetch, and not out of habit. Outbound HTTPS may go through an agent
// proxy that supplies the real credential while the token in the environment is a
// placeholder. curl honours HTTPS_PROXY; node's built-in fetch (undici) does not
// read those variables, so it goes direct, presents the placeholder, and returns a
// flat 401 that reads like a bad token. Same shape as the job-logs trap in
// docs/internals/e2e-hygiene.md.
function api(path) {
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "-H",
      `Authorization: Bearer ${TOKEN}`,
      "-H",
      "Accept: application/vnd.github+json",
      `https://api.github.com${path}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const json = JSON.parse(out);
  if (!Array.isArray(json) && json?.message) {
    throw new Error(`${json.message} — ${path}`);
  }
  return json;
}

const runs = api(
  `/repos/${OWNER}/${REPO}/actions/workflows/ci.yml/runs?per_page=40`
).workflow_runs.filter((r) => !since || r.created_at >= since);

let exposures = 0;
const hits = [];
const others = new Map();

for (const run of runs) {
  const shards = api(
    `/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs?per_page=60`
  ).jobs.filter((j) => /^e2e \(\d+\)$/.test(j.name));
  const reported = shards.filter(
    (j) => j.conclusion === "success" || j.conclusion === "failure"
  );
  if (reported.length < 12) continue;
  exposures++;

  for (const job of shards.filter((j) => j.conclusion === "failure")) {
    let anns = [];
    try {
      anns = api(`/repos/${OWNER}/${REPO}/check-runs/${job.id}/annotations`);
    } catch {
      // A shard whose annotations we cannot read still counted as an exposure —
      // dropping the run here would understate the denominator.
      continue;
    }
    for (const a of anns) {
      const spec = a.path ?? "";
      if (!spec.startsWith("e2e/")) continue;
      if (spec.includes(needle)) {
        hits.push(
          `${run.head_sha.slice(0, 8)} ${job.name} ${spec}:${a.start_line}`
        );
      } else {
        others.set(spec, (others.get(spec) ?? 0) + 1);
      }
    }
  }
}

const scope = since ? ` since ${since}` : "";
console.log(`exposures (full 12-shard matrices${scope}): ${exposures}`);
console.log(`"${needle}" failures: ${hits.length}`);
for (const h of hits) console.log("  " + h);

if (others.size) {
  console.log("other failing specs seen, by annotation count:");
  for (const [spec, n] of [...others].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}\t${spec}`);
  }
}

// The caveat ships WITH the number, so the number cannot be quoted without it.
if (exposures > 0 && hits.length === 0) {
  const p = Math.pow(1 - BASELINE_RATE, exposures);
  const needed = Math.ceil(Math.log(SIGNAL_P) / Math.log(1 - BASELINE_RATE));
  console.log(
    `\nAt the pre-fix ~1-in-${Math.round(1 / BASELINE_RATE)} rate, ${exposures} clean ` +
      `exposure(s) would happen by chance ${(p * 100).toFixed(1)}% of the time. ` +
      `About ${needed} are needed before a clean streak means anything (p < ${SIGNAL_P}).`
  );
}
