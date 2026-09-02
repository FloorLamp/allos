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
// `work-checkin.sh` does: an experiment that spans days cannot have its
// instrument deleted by a container restart.
//
// WHAT COUNTS AS AN EXPOSURE. Only a run where all twelve `e2e (N)` shards reached
// a verdict. A matrix that was cancelled, superseded by a newer push, or skipped is
// not a trial, and counting it would dilute the denominator in the direction that
// flatters the fix.
//
// Usage:
//   node scripts/flake-census.mjs <spec-substring> [sinceISO] [baselineRate]
//   node scripts/flake-census.mjs overlay-gestures 2026-08-14T07:54:00Z 0.167
//
// The baseline is the flake's MEASURED pre-fix per-matrix rate. It is an argument
// rather than a constant on purpose — see below.

import { execFileSync } from "node:child_process";
// Named import: `api(path)` below binds `path` as a parameter.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "FloorLamp";
const REPO = "allos";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
/** Below this, a clean streak stops being something chance explains comfortably. */
const SIGNAL_P = 0.05;

/**
 * The three units a "failure" can be counted in, from the annotation records.
 *
 * WHAT UNIT IS THIS NUMBER IN. The headline used to print `hits.length` — a count
 * of ANNOTATIONS — under the word "failures", against a denominator counted in
 * MATRICES (#2845). One failing test yields two or three annotations (the assertion
 * line, a `:0` timeout line, sometimes a context close), so the headline overstated
 * by two or three, and the only reason #2839 survived it is that someone divided.
 *
 * MATRICES is the numerator that matches the denominator: `exposures` counts RUNS,
 * so the comparable numerator is runs in which the spec failed. Not head SHAs — a
 * re-run of the same commit is a second, independent exposure and is counted as one
 * below the line, so counting heads here would silently deflate the numerator alone.
 * Shards and annotations stay, under their own names, because they are what the
 * detail lines are made of.
 */
export function failureUnits(hits) {
  return {
    matrices: new Set(hits.map((h) => h.runId)).size,
    shards: new Set(hits.map((h) => `${h.runId}:${h.job}`)).size,
    annotations: hits.length,
  };
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

function main(argv) {
  const [needle, since, baselineArg] = argv;
  if (!needle) {
    console.error(
      "usage: node scripts/flake-census.mjs <spec-substring> [sinceISO] [baselineRate]\n" +
        "  baselineRate: the flake's MEASURED pre-fix per-matrix rate, e.g. 0.167.\n" +
        "  Omit it and no chance calculation is printed."
    );
    process.exit(2);
  }
  // The baseline must be SUPPLIED, never assumed. A hardcoded default gets inherited
  // by whatever spec the next person types, and then the tool prints a confident
  // p-value computed against a rate that was measured on a different bug — which is
  // precisely the misreading this script exists to prevent, wearing the script's own
  // authority. No baseline, no verdict; the counts still print.
  const baseline = baselineArg === undefined ? null : Number(baselineArg);
  if (baseline !== null && !(baseline > 0 && baseline < 1)) {
    console.error(`baselineRate must be between 0 and 1 (got ${baselineArg}).`);
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("GH_TOKEN (or GITHUB_TOKEN) must be set.");
    process.exit(2);
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
        const record = {
          runId: run.id,
          headSha: run.head_sha,
          job: job.name,
          spec,
          line: a.start_line,
        };
        if (spec.includes(needle)) hits.push(record);
        else {
          const seen = others.get(spec) ?? {
            annotations: 0,
            runIds: new Set(),
          };
          seen.annotations++;
          seen.runIds.add(run.id);
          others.set(spec, seen);
        }
      }
    }
  }

  const units = failureUnits(hits);
  const scope = since ? ` since ${since}` : "";
  console.log(`exposures (full 12-shard matrices${scope}): ${exposures}`);
  // Numerator and denominator in the same unit, and every other unit named as itself.
  console.log(
    `"${needle}" failing matrices: ${units.matrices} of ${exposures} ` +
      `(${units.shards} shard(s), ${units.annotations} annotation line(s))`
  );
  for (const h of hits)
    console.log(`  ${h.headSha.slice(0, 8)} ${h.job} ${h.spec}:${h.line}`);

  if (others.size) {
    console.log("other failing specs seen (matrices, annotation lines):");
    for (const [spec, seen] of [...others].sort(
      (a, b) =>
        b[1].runIds.size - a[1].runIds.size ||
        b[1].annotations - a[1].annotations
    )) {
      console.log(`  ${seen.runIds.size}\t${seen.annotations}\t${spec}`);
    }
  }

  // The caveat ships WITH the number, so the number cannot be quoted without it —
  // and only when a measured baseline was supplied to judge the streak against.
  if (exposures > 0 && units.matrices === 0 && baseline !== null) {
    const p = Math.pow(1 - baseline, exposures);
    const needed = Math.ceil(Math.log(SIGNAL_P) / Math.log(1 - baseline));
    console.log(
      `\nAt the stated pre-fix rate of ~1-in-${Math.round(1 / baseline)}, ${exposures} clean ` +
        `exposure(s) would happen by chance ${(p * 100).toFixed(1)}% of the time. ` +
        `About ${needed} are needed before a clean streak means anything (p < ${SIGNAL_P}).`
    );
  } else if (exposures > 0 && units.matrices === 0) {
    console.log(
      `\nNo chance calculation: pass the flake's measured pre-fix rate as a third ` +
        `argument to judge this streak against something.`
    );
  }
}

// Guarded so importing this module for its counting rule does not curl GitHub.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main(process.argv.slice(2));
