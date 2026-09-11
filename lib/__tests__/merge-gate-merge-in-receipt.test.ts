// A RECEIPT THAT SURVIVES A MAIN MERGE-IN (#4994).
//
// The merge gate requires a receipt stating the CURRENT head, and a merge of
// `origin/main` into a branch moves the head without changing the change. On
// 2026-09-03 four reviews were re-given for exactly that. The acceptance makes
// the gate LESS strict, and the defect it could introduce is not a wrong
// refusal but A CHANGE MERGING ON A REVIEW NOBODY GAVE — so every case here
// that opens the gate is paired with a neighbour that must still refuse:
// one edited line alongside the merge, a receipt on a commit the head left
// behind, an empty diff, a read that did not answer.
//
// THE FIRST SUITE IS A REAL GIT REPOSITORY, because the hunk-offset and
// index-line decision is a claim about what git actually prints across a real
// merge-in, and a hand-written fixture would only prove that the normaliser
// matches the strings its author chose. `git diff main...<commit>` is the same
// three-dot diff the gate reads from `compare/{base}...{sha}`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  mergeInReceipt,
  normaliseDiff,
} from "../../scripts/orchestration/merge-gate-core.mjs";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/orchestration/merge-gate.mjs", import.meta.url)
);

/** git, with an identity of its own so no global config is required. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

const rev = (cwd: string) => git(cwd, "rev-parse", "HEAD").trim();
const commit = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
  return rev(cwd);
};

const line = (n: number) => `export const line${n} = ${n};\n`;
const body = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => line(from + i)).join("");

describe("what a real merge-in does to a three-dot diff", () => {
  let root: string;
  let threeDot: (ref: string) => string;
  let reviewedSha: string;
  let mergedSha: string;

  beforeAll(() => {
    root = makeTmpDir("merge-in-receipt");
    git(root, "init", "-q", "-b", "main", ".");
    // Two files, so main can move ABOVE a hunk in one and edit the OTHER
    // without touching what the branch does to either.
    fs.writeFileSync(path.join(root, "moved.ts"), body(1, 60));
    fs.writeFileSync(path.join(root, "elsewhere.ts"), body(1, 20));
    commit(root, "base");

    git(root, "checkout", "-q", "-b", "pr");
    fs.writeFileSync(
      path.join(root, "moved.ts"),
      body(1, 30) + "export const ADDED_BY_PR = true;\n" + body(31, 60)
    );
    reviewedSha = commit(root, "the change under review");

    git(root, "checkout", "-q", "main");
    // ABOVE the branch's hunk in one file, and inside the other — the two ways
    // main moves a diff without moving the change.
    fs.writeFileSync(
      path.join(root, "moved.ts"),
      "export const MAIN_GREW = 1;\nexport const MAIN_GREW_MORE = 2;\n" +
        body(1, 60)
    );
    fs.writeFileSync(
      path.join(root, "elsewhere.ts"),
      body(1, 10) + "export const MAIN_TOUCHED_THIS = true;\n" + body(11, 20)
    );
    commit(root, "main moves");

    git(root, "checkout", "-q", "pr");
    git(root, "merge", "-q", "--no-edit", "main");
    mergedSha = rev(root);

    // THE SAME MERGE-IN, CARRYING ONE MORE EDITED LINE — and the line is inside
    // the file and the hunk the PR already changed, so nothing coarser than
    // comparing the hunk BODIES can tell this apart from the clean merge-in
    // above: same files, same hunk count, same offsets.
    git(root, "checkout", "-q", "-b", "pr-plus-one", reviewedSha);
    git(root, "merge", "-q", "--no-edit", "main");
    fs.writeFileSync(
      path.join(root, "moved.ts"),
      git(root, "show", "HEAD:moved.ts").replace(
        "export const ADDED_BY_PR = true;",
        "export const ADDED_BY_PR = false;"
      )
    );
    commit(root, "one more line, riding in with the merge");

    threeDot = (ref: string) => git(root, "diff", `main...${ref}`);
    // The fixture only tests anything if the merge-in really moved the head.
    expect(mergedSha).not.toBe(reviewedSha);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("moves hunk offsets and blob ids while the content stands still", () => {
    const before = threeDot(reviewedSha);
    const after = threeDot(mergedSha);

    // THE MEASUREMENT THE DECISION RESTS ON, made both ways round: verbatim
    // these differ, and what differs is only addressing.
    expect(after).not.toBe(before);
    const was = before.split("\n");
    const changed = after.split("\n").filter((l, i) => l !== was[i]);
    expect(changed.length).toBeGreaterThan(0);
    for (const l of changed)
      expect(l).toMatch(
        /^(@@ -\d+(,\d+)? \+\d+(,\d+)? @@|index [0-9a-f]+\.\.)/
      );

    expect(normaliseDiff(after)).toBe(normaliseDiff(before));
  });

  it("keeps one extra edited line visible through the normaliser", () => {
    const before = threeDot(reviewedSha);
    const plusOne = threeDot("pr-plus-one");

    expect(normaliseDiff(plusOne)).not.toBe(normaliseDiff(before));
    // And the difference is that line and nothing else — the two diffs touch
    // the same files, in the same hunks, at the same offsets.
    expect(plusOne).toContain("+export const ADDED_BY_PR = false;");
    expect(
      normaliseDiff(plusOne)
        .split("\n")
        .filter(
          (l) => !normaliseDiff(threeDot(mergedSha)).split("\n").includes(l)
        )
    ).toEqual(["+export const ADDED_BY_PR = false;"]);
  });

  it("keeps the hunk line counts and the section heading verbatim", () => {
    const normalised = normaliseDiff(threeDot(mergedSha));
    expect(normalised).toContain("@@ -_,6 +_,7 @@");
    expect(normalised).toContain("index _.._ 100644");
    expect(normalised).not.toMatch(/@@ -\d/);
    expect(normalised).not.toMatch(/index [0-9a-f]{4,}\.\./);
  });
});

describe("what the normaliser does to a diff", () => {
  // The abbreviation-width case, measured on this repository 2026-09-11:
  // `compare/main...8ba212f7` and `compare/main...ca2e88b9` printed the SAME
  // blobs at ten and nine characters. Two reads, one repository, identical
  // content — which is why verbatim comparison is arbitrary here rather than
  // strict, and why the index line is normalised at all.
  const wide = "index 89cc43fff5..7baabf2b0c 100644";
  const narrow = "index 89cc43fff..7baabf2b0 100644";

  it("reads one blob printed at two widths as one blob", () => {
    expect(normaliseDiff(wide)).toBe(normaliseDiff(narrow));
  });

  it("still refuses a genuinely different blob at the same width", () => {
    // Normalising index lines is safe ONLY because the hunks below them carry
    // the change. A file whose blob moved and whose hunk moved with it must
    // still read as different.
    const a = `${wide}\n@@ -1,2 +1,3 @@\n one\n+two\n`;
    const b = `${narrow}\n@@ -1,2 +1,3 @@\n one\n+three\n`;
    expect(normaliseDiff(a)).not.toBe(normaliseDiff(b));
  });

  it("does not touch a content line that looks like a header", () => {
    // Every content line carries a `+`, `-` or space, so nothing inside a hunk
    // can be mistaken for addressing — including a file that itself contains
    // the word `index` or an `@@` line.
    const diff = "+index abcdef12..34567890 100644\n-@@ -1,1 +1,1 @@\n";
    expect(normaliseDiff(diff)).toBe(diff);
  });
});

describe("the merge-in verdict", () => {
  const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  const REVIEWED = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
  const DIFF = "diff --git a/x.ts b/x.ts\n@@ -1,1 +1,2 @@\n one\n+two\n";
  const SHIFTED = "diff --git a/x.ts b/x.ts\n@@ -9,1 +9,2 @@\n one\n+two\n";
  const EDITED = "diff --git a/x.ts b/x.ts\n@@ -1,1 +1,2 @@\n one\n+three\n";
  const ancestor = { merge_base_commit: { sha: REVIEWED } };

  const verdict = (over: Record<string, unknown>) =>
    mergeInReceipt({
      head: HEAD,
      reviewed: REVIEWED,
      who: "reviewer",
      ancestry: ancestor,
      reviewedDiff: DIFF,
      headDiff: DIFF,
      ...over,
    });

  it("opens on an ancestor whose diff only shifted", () => {
    const survived = verdict({ headDiff: SHIFTED });
    expect(survived.ok).toBe(true);
    expect(survived.message).toContain("receipt survives a main merge-in");
  });

  it.each([
    [
      "a commit the head left behind",
      { ancestry: { merge_base_commit: { sha: "0000000000000000" } } },
      "not-ancestor",
    ],
    [
      "an ancestry read that did not answer",
      { ancestry: null },
      "unreadable-ancestry",
    ],
    ["a diff read that did not answer", { headDiff: null }, "unreadable-diff"],
    [
      "an ancestor with nothing in its diff",
      { reviewedDiff: "", headDiff: "" },
      "empty-diff",
    ],
    ["one line of content different", { headDiff: EDITED }, "changed"],
  ])("refuses %s", (_name, over, kind) => {
    const refused = verdict(over as Record<string, unknown>);
    expect(refused.ok).toBe(false);
    expect(refused.kind).toBe(kind);
  });
});

// THE GATE ITSELF, over a stubbed transport (the harness
// merge-gate-max-buffer.test.ts uses). The pure suite above proves the verdict;
// this proves the WIRING, and one thing only it can prove: that each side's
// diff is fetched from its OWN three-dot compare against the base branch. A
// shared base — both sides read against the head's merge base, or both against
// the reviewed commit's — is the hole #4994 names third, and the only place it
// is visible is in the URLs the gate asks for.
describe("the gate's receipt row over a merge-in", () => {
  const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  const REVIEWED = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
  const FORCE_PUSHED = "cccc3333cccc3333cccc3333cccc3333cccc3333";
  const CLEAN =
    "diff --git a/lib/x.ts b/lib/x.ts\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/lib/x.ts\n+++ b/lib/x.ts\n" +
    "@@ -12,3 +12,4 @@ export function f() {\n one\n two\n+added by the PR\n three\n";
  // The same change after a clean merge-in: main grew above the hunk and
  // touched the file elsewhere, so the offsets and the blob ids moved.
  const SHIFTED = CLEAN.replace(
    "@@ -12,3 +12,4 @@",
    "@@ -19,3 +19,4 @@"
  ).replace("index 1111111..2222222", "index 4444444..5555555");
  const EDITED = SHIFTED.replace(
    "added by the PR",
    "added by the PR, and more"
  );

  const bin = makeTmpDir("merge-in-gate");
  afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

  const put = (name: string, text: string) => {
    fs.writeFileSync(path.join(bin, name), text);
    return path.join(bin, name);
  };
  /** A path as the stub's `sh` must read it — quoted, since `bin` is a mktemp. */
  const sh = (file: string) => JSON.stringify(file);
  const review = (sha: string) => ({
    state: "COMMENTED",
    user: { login: "reviewer" },
    body: `Reviewed ${sha.slice(0, 8)} — looks right.`,
  });

  const prFile = put(
    "pr.json",
    JSON.stringify({
      number: 9,
      state: "open",
      draft: false,
      title: "A title the gate accepts",
      body: "",
      user: { login: "author" },
      head: { sha: HEAD, ref: "a-branch" },
      base: { ref: "main" },
    })
  );
  const commitsFile = put(
    "commits.json",
    JSON.stringify([
      { sha: REVIEWED, parents: [{}], commit: { message: "the change" } },
      {
        sha: HEAD,
        parents: [{}, {}],
        commit: { message: "Merge origin/main" },
      },
    ])
  );
  const onReviewed = put(
    "reviews-reviewed.json",
    JSON.stringify([review(REVIEWED)])
  );
  const onForced = put(
    "reviews-forced.json",
    JSON.stringify([review(FORCE_PUSHED)])
  );
  const cleanFile = put("clean.diff", CLEAN);
  const shiftedFile = put("shifted.diff", SHIFTED);
  const editedFile = put("edited.diff", EDITED);
  const ancestorFile = put(
    "ancestor.json",
    JSON.stringify({ merge_base_commit: { sha: REVIEWED }, status: "ahead" })
  );
  const divergedFile = put(
    "diverged.json",
    JSON.stringify({
      merge_base_commit: { sha: "9999999999" },
      status: "diverged",
    })
  );
  const baseMovedFile = put(
    "base-moved.json",
    JSON.stringify({
      merge_base_commit: { sha: HEAD },
      total_commits: 0,
      commits: [],
      files: [],
    })
  );

  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *graphql*) printf '{}\\n403' ;;
  *vnd.github.diff*compare/main...${HEAD}*) cat "$STUB_HEAD_DIFF"; printf '\\n200' ;;
  *vnd.github.diff*compare/main...${REVIEWED}*) cat ${sh(cleanFile)}; printf '\\n200' ;;
  *compare/${REVIEWED}...${HEAD}*) cat "$STUB_ANCESTRY"; printf '\\n200' ;;
  *pulls/9/commits*) cat ${sh(commitsFile)}; printf '\\n200' ;;
  *pulls/9/reviews*) cat "$STUB_REVIEWS"; printf '\\n200' ;;
  *comments*|*pulls/9/files*) printf '[]\\n200' ;;
  *check-runs*) printf '{"total_count":1,"check_runs":[{"id":1,"name":"a-check","status":"completed","conclusion":"success"}]}\\n200' ;;
  */status*) printf '{"state":"success","statuses":[]}\\n200' ;;
  *compare*) cat ${sh(baseMovedFile)}; printf '\\n200' ;;
  *pulls/9*) cat ${sh(prFile)}; printf '\\n200' ;;
  *) printf '{}\\n200' ;;
esac
`
  );
  fs.chmodSync(path.join(bin, "curl"), 0o755);

  const run = (env: Record<string, string>) => {
    const log = path.join(bin, `log-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(log, "");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "9", "--repo", "owner/name", "--session", "session_0test12"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "test",
          PATH: `${bin}:${process.env.PATH}`,
          STUB_LOG: log,
          STUB_REVIEWS: onReviewed,
          STUB_ANCESTRY: ancestorFile,
          ...env,
        },
      }
    );
    return { ...result, asked: fs.readFileSync(log, "utf8") };
  };

  it("opens the receipt row on a byte-identical merge-in", () => {
    const gate = run({ STUB_HEAD_DIFF: shiftedFile });
    expect(gate.stdout).toContain(
      `PASS: receipt survives a main merge-in: reviewer states ${REVIEWED.slice(0, 8)}`
    );
    // EACH SIDE AGAINST ITS OWN MERGE BASE: two three-dot compares off `main`,
    // one per commit, plus the ancestry read. Nothing asks for one shared base.
    expect(gate.asked).toContain(`compare/main...${REVIEWED}`);
    expect(gate.asked).toContain(`compare/main...${HEAD}`);
    expect(gate.asked).toContain(`compare/${REVIEWED}...${HEAD}`);
    expect(gate.asked).not.toContain(`compare/${REVIEWED}...${REVIEWED}`);
  });

  it("refuses the same merge-in carrying one edited line", () => {
    const gate = run({ STUB_HEAD_DIFF: editedFile });
    expect(gate.stdout).toContain("FAIL: no receipt for aaaa1111");
    expect(gate.stdout).toContain(
      `CHANGED between ${REVIEWED.slice(0, 8)} and ${HEAD.slice(0, 8)}`
    );
    expect(gate.stdout).not.toContain("receipt survives");
  });

  it("refuses a receipt on a commit that is not an ancestor of the head", () => {
    const gate = run({
      STUB_HEAD_DIFF: shiftedFile,
      STUB_ANCESTRY: divergedFile,
    });
    expect(gate.stdout).toContain(
      `${REVIEWED.slice(0, 8)} is NOT an ancestor of ${HEAD.slice(0, 8)}`
    );
    expect(gate.stdout).not.toContain("receipt survives");
  });

  it("refuses a receipt on a commit the PR no longer carries, reading no diff", () => {
    // What a force-push actually leaves behind: the reviewed commit is off the
    // listing entirely, so there is nothing to compare and nothing is compared.
    const gate = run({ STUB_HEAD_DIFF: shiftedFile, STUB_REVIEWS: onForced });
    expect(gate.stdout).toContain("FAIL: no receipt for aaaa1111");
    expect(gate.stdout).not.toContain("receipt survives");
    expect(gate.asked).not.toContain("vnd.github.diff");
  });
});
