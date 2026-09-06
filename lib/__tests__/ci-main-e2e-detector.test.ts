import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two documents that must stay in step (#2969, ruled 2026-08-16).
//
// `ci-main.yml`'s header argues the browser matrix should not run per merge.
// `e2e-main.yml` runs one. Both statements were true at once on main, and the
// defect was not the workflow — the owner authorized it — but the header left
// arguing against it: an implementer reading that header would reasonably
// conclude e2e-main.yml is a mistake and delete the only e2e coverage main has.
//
// Prose cannot be tested for being persuasive, so this tests the narrow thing
// that actually matters: while a per-merge browser matrix exists, the header
// must record that the objection is superseded, why, and — the half that is
// easiest to lose in an edit — that it is superseded ONLY for a detector, never
// for a gate. Drop the workflow and this guard goes with it, which is the right
// coupling: the record exists because the workflow does.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const read = (p: string) =>
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", p), "utf8");

// The workflow's TRIGGERS, read as structure rather than as text (#3000).
//
// The first version of this file string-matched `branches: [main]` anywhere in
// e2e-main.yml, which says nothing about what the workflow runs ON: adding
// `pull_request:` alongside the push trigger — the exact promotion #2969's
// ruling withheld authorization for — left every assertion green. A scope guard
// that a string satisfies is guarding the vocabulary, not the scope.
//
// No YAML dependency, because this repo has none and one test is not a reason
// to take one. The shape being read is narrow: a top-level `on:` key, either a
// flow list on the same line or an indented block of event names. Both forms
// are handled, and the parser is asserted to have found something before
// anything is concluded from what it did not find.
const indentOf = (l: string) => l.length - l.trimStart().length;
const isSkippable = (l: string) => l.trim() === "" || /^\s*#/.test(l);

function blockUnder(lines: string[], headerIdx: number) {
  const header = lines[headerIdx];
  const indent = indentOf(header);
  const inline = header.slice(header.indexOf(":") + 1).trim();
  const body: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) break;
    body.push(lines[i]);
  }
  return { inline, body };
}

function keyIndex(lines: string[], key: string, indent: number) {
  return lines.findIndex(
    (l) =>
      !isSkippable(l) &&
      indentOf(l) === indent &&
      l.trim().startsWith(`${key}:`)
  );
}

/** Every event name declared by a workflow's top-level `on:`. */
function triggerEvents(yaml: string): string[] {
  const lines = yaml.split("\n");
  const idx = keyIndex(lines, "on", 0);
  if (idx < 0) return [];
  const { inline, body } = blockUnder(lines, idx);
  // `on: push` / `on: [push, pull_request]`
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const childIndent = body.length ? indentOf(body[0]) : -1;
  const names: string[] = [];
  for (const l of body) {
    if (indentOf(l) !== childIndent) continue;
    // `push:` (mapping) and `- push` (sequence) both declare an event.
    const m = /^\s*(?:-\s*)?([A-Za-z_][A-Za-z0-9_-]*)\s*:?\s*(?:#.*)?$/.exec(l);
    if (m) names.push(m[1]);
  }
  return names;
}

/** The text of one event's configuration under `on:`, e.g. `push:`. */
function triggerConfig(yaml: string, event: string): string {
  const lines = yaml.split("\n");
  const idx = keyIndex(lines, "on", 0);
  if (idx < 0) return "";
  const { body } = blockUnder(lines, idx);
  const childIndent = body.length ? indentOf(body[0]) : 0;
  const evIdx = keyIndex(body, event, childIndent);
  if (evIdx < 0) return "";
  const { inline, body: conf } = blockUnder(body, evIdx);
  return [inline, ...conf].join("\n");
}

describe("the post-merge e2e detector and ci-main.yml's header", () => {
  const e2eMainPath = path.join(
    repoRoot,
    ".github",
    "workflows",
    "e2e-main.yml"
  );

  it("still runs a browser matrix on every push to main", () => {
    expect(fs.existsSync(e2eMainPath)).toBe(true);
    const e2eMain = read("e2e-main.yml");
    expect(triggerEvents(e2eMain)).toContain("push");
    expect(triggerConfig(e2eMain, "push")).toMatch(
      /branches:\s*(\[\s*main\s*\]|\n\s*-\s*main\b)/
    );
    expect(e2eMain).toMatch(/matrix:\s*\n\s*shard:/);
  });

  it("read the triggers as triggers, so the assertion below can mean anything", () => {
    // If the parser stopped finding the `on:` block, every "does not trigger on
    // X" assertion would pass vacuously — which is the failure this whole test
    // was rewritten to remove. Prove it found the real thing first.
    const events = triggerEvents(read("e2e-main.yml"));
    expect(events).toEqual(
      expect.arrayContaining(["push", "workflow_dispatch"])
    );
    // And prove it can SEE a pull_request trigger, on a workflow that has one.
    expect(triggerEvents(read("ci.yml"))).toContain("pull_request");
  });

  it("records in ci-main.yml that the objection is superseded, and by what", () => {
    const ciMain = read("ci-main.yml");
    expect(ciMain).toMatch(/SUPERSEDED/);
    // The ruling, and the receipt it rests on — two PRs green on their own
    // heads merging into a red main.
    expect(ciMain).toContain("#2969");
    expect(ciMain).toContain("#2791");
  });

  it("keeps the supersession SCOPED to a detector, not a gate", () => {
    // The objection still stands against promoting the matrix to a per-merge
    // gate. A record that drops the scope authorizes more than was ruled.
    const ciMain = read("ci-main.yml");
    expect(ciMain).toMatch(/GATE/);
    expect(ciMain).toMatch(/detector/i);
  });

  // THE SCOPE ITSELF, not the words describing it (#3000).
  //
  // "Detector, not gate" is a statement about WHEN the browser matrix runs. A
  // detector runs after the merge and reports; a gate runs on the pull request
  // and blocks it. So the authorization #2969 withheld is visible in exactly
  // one place — e2e-main.yml's trigger list — and it is the only assertion here
  // that a rewrite of the prose cannot satisfy.
  it("does NOT trigger the browser matrix on a pull request", () => {
    const events = triggerEvents(read("e2e-main.yml"));
    expect(events).not.toContain("pull_request");
    expect(events).not.toContain("pull_request_target");
    expect(events).not.toContain("merge_group");
  });

  // THE NIGHTLY, AND WHY IT IS A TRIGGER ASSERTION AND NOT A PROSE ONE (#4370).
  //
  // The push detector is correct and its skip is a sensible optimisation. What
  // it cannot do is watch breakage that no diff caused: #4358's fixture aged out
  // at midnight and nine consecutive main runs skipped, so main never observed
  // it. The nightly is the only part of this workflow that runs whatever the
  // diff was, so it is the only part that covers that class — and like the
  // pull_request assertion above, it lives in the trigger list, where no rewrite
  // of the surrounding prose can satisfy it.
  it("runs the suite unconditionally on a nightly schedule", () => {
    const e2eMain = read("e2e-main.yml");
    expect(triggerEvents(e2eMain)).toContain("schedule");
    expect(triggerConfig(e2eMain, "schedule")).toMatch(
      /cron:\s*"[^"]*\*\s+\*\s+\*"/
    );
  });

  // A SKIPPED SHARD MUST NOT REPORT `success` (#4370 part 2).
  //
  // The detection used to sit inside the matrix job, on each step's `if:`. Four
  // shards then completed with every step skipped and a conclusion of SUCCESS —
  // which a badge, a person and merge-gate-core's `baseDetectorNotice` all read
  // as "ran and passed". Hoisting it into its own job is what makes the shards
  // report `skipped` instead, so the guard is that the gating is at JOB level:
  // a per-step `if:` on the browser steps is the defect, whatever it is worded
  it("gates the browser matrix at job level, so a skip reports as a skip", () => {
    const e2eMain = read("e2e-main.yml");
    expect(e2eMain).toMatch(/^\s+needs: detect$/m);
    expect(e2eMain).toMatch(/^\s+if: needs\.detect\.outputs\.code == 'true'$/m);
    const lines = e2eMain.split("\n");
    const matrixJob = lines.slice(keyIndex(lines, "e2e-main", 2)).join("\n");
    expect(matrixJob).toContain("Playwright, shard");
    expect(matrixJob).not.toContain("steps.changes");
  });
});
