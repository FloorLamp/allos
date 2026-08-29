import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  annotationFor,
  classifyCommit,
  escapeAnnotation,
  escapeAnnotationProperty,
  explainCommit,
  explainReport,
} from "../../scripts/gitleaks-explain.mjs";
import { makeTmpDir } from "./tmp-dir";

// Guard for the gitleaks failure explainer (#2949), in the repo's source-scan
// idiom — filesystem only, no DB, no network.
//
// The defect it fixes is a MESSAGE, not a scan: a full-history `--all` scan
// reads every ref pushed to the repository, so one branch's credential-shaped
// fixture reds `gitleaks` on every open PR and names a file the PR never
// touched. The explainer's whole job is to say which ref the finding came from
// and that a deletion commit will not clear it. If either sentence goes missing
// the check is back to being unreadable, which is exactly the state nothing else
// would notice.
//
// #2969 narrowed PRs to their range; #3046 applies the same ownership rule to
// pushes and moves `--all` to scheduled/manual audits. The second describe below
// executes the workflow's own range logic rather than reading its comments.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");

const baseLabel = "origin/main";

function info(over: Record<string, unknown> = {}) {
  return {
    commit: "abc123def4567890",
    kind: "elsewhere",
    refs: ["origin/claude/other-cluster"],
    subject: "add redaction fixtures",
    author: "Someone",
    date: "2026-08-16",
    ...over,
  };
}

const finding = {
  File: "lib/__tests__/error-log-format.test.ts",
  StartLine: 41,
  RuleID: "jwt",
  Commit: "abc123def4567890",
};

describe("classifyCommit", () => {
  it("puts a commit already in the base ahead of 'this branch introduced it'", () => {
    // A PR check runs on the MERGE commit, so everything in main is reachable
    // from HEAD. Without the base test every long-standing literal would read as
    // newly introduced by whichever PR happened to run.
    expect(classifyCommit({ onHead: true, onBase: true, commit: "a" })).toBe(
      "base"
    );
  });

  it("calls a commit on the head but not the base this branch's", () => {
    expect(classifyCommit({ onHead: true, onBase: false, commit: "a" })).toBe(
      "branch"
    );
  });

  it("calls a commit unreachable from the head another ref's", () => {
    expect(classifyCommit({ onHead: false, onBase: false, commit: "a" })).toBe(
      "elsewhere"
    );
  });

  it("does not attribute a finding that carries no commit", () => {
    expect(classifyCommit({ onHead: false, onBase: false, commit: "" })).toBe(
      "unknown"
    );
  });
});

describe("explainCommit", () => {
  it("names the ref a foreign finding came from, and says a deletion will not clear it", () => {
    const text = explainCommit(info(), [finding], { baseLabel });
    expect(text).toContain("NOT on this branch");
    expect(text).toContain("origin/claude/other-cluster");
    expect(text).toContain("lib/__tests__/error-log-format.test.ts:41");
    expect(text).toContain("abc123def4"); // short sha
    // The non-guessable recovery step, and the one that looks right and is not.
    expect(text).toMatch(/DELETES the line does NOT clear it/);
    expect(text).toMatch(/amend|rebase/);
    expect(text).toContain("Nothing in this pull request introduced this");
  });

  it("says a commit on no ref at all is on no ref, rather than printing an empty list", () => {
    const text = explainCommit(info({ refs: [] }), [finding], { baseLabel });
    expect(text).toContain("the commit is on no ref in this checkout");
  });

  it("tells a branch's own finding to rewrite history rather than delete", () => {
    const text = explainCommit(info({ kind: "branch" }), [finding], {
      baseLabel,
    });
    expect(text).toContain("Introduced by this branch");
    expect(text).toMatch(/DELETES the line does NOT clear it/);
    expect(text).toMatch(/amend|rebase/);
  });

  it("tells a base finding it was not introduced here and a rebase will not help", () => {
    const text = explainCommit(info({ kind: "base" }), [finding], {
      baseLabel,
    });
    expect(text).toContain("already in origin/main");
    expect(text).toContain("rebasing will not remove it");
  });

  it("groups every finding of one commit under that commit's explanation", () => {
    const second = {
      ...finding,
      File: "lib/__tests__/other.test.ts",
      StartLine: 7,
    };
    const text = explainCommit(info(), [finding, second], { baseLabel });
    expect(text).toContain("lib/__tests__/error-log-format.test.ts:41");
    expect(text).toContain("lib/__tests__/other.test.ts:7");
    expect(text.match(/NOT on this branch/g)).toHaveLength(1);
  });
});

describe("explainReport", () => {
  it("leads with the headline that matters: none of this is yours", () => {
    const text = explainReport([[info(), [finding]]], { baseLabel });
    expect(text).toContain("**No finding here is on this branch.**");
  });

  it("withholds that headline when the branch does own one of the findings", () => {
    const text = explainReport(
      [
        [info(), [finding]],
        [info({ commit: "ffff", kind: "branch" }), [finding]],
      ],
      { baseLabel }
    );
    expect(text).not.toContain("**No finding here is on this branch.**");
    expect(text).toContain("1 on this branch");
    expect(text).toContain("1 from other refs");
  });

  it("says so when it stopped resolving commits rather than silently truncating", () => {
    const text = explainReport([[info(), [finding]]], {
      baseLabel,
      truncated: 3,
    });
    expect(text).toContain("3 further commits");
  });
});

describe("workflow-command escaping", () => {
  it("encodes newlines so a multi-line explanation survives as one annotation", () => {
    expect(escapeAnnotation("a\nb")).toBe("a%0Ab");
    expect(escapeAnnotation("100%")).toBe("100%25");
    expect(escapeAnnotation("a\r\nb")).toBe("a%0D%0Ab");
  });

  it("also encodes the property delimiters inside a title", () => {
    expect(escapeAnnotationProperty("a:b,c")).toBe("a%3Ab%2Cc");
  });

  it("emits one error annotation whose body carries no raw newline", () => {
    const line = annotationFor(info(), [finding], { baseLabel });
    expect(line.startsWith("::error title=")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("origin/claude/other-cluster");
  });
});

describe("the gitleaks workflow wires the explainer in", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "gitleaks.yml"),
    "utf8"
  );

  it("writes a JSON report and hands that same path to the explainer", () => {
    expect(workflow).toContain('--report-format json --report-path "$report"');
    expect(workflow).toContain('node scripts/gitleaks-explain.mjs "$report"');
  });

  it("keeps --redact on the scan, which is what makes the report safe to print", () => {
    // The explainer reads the report back and prints file/line/commit into a
    // PUBLIC log. --redact is the only reason no secret material rides along.
    expect(workflow).toMatch(/gitleaks git --log-opts="\$log_opts" --redact/);
  });

  it("still exits with gitleaks' own status, so explaining cannot become passing", () => {
    expect(workflow).toContain("status=$?");
    expect(workflow).toContain('exit "$status"');
  });

  it("gives the explainer a base ref, without which every merge-commit finding reads as new", () => {
    expect(workflow).toContain("GITLEAKS_BASE_REF:");
  });
});

// The scan RANGE, executed rather than read (#2969, ruled 2026-08-16).
//
// Every branch-scoped event scans only that branch's commits, so one branch's
// credential-shaped fixture cannot red another branch's push or PR. Scheduled
// and manual runs retain the repository-wide `--all` audit (#3046).
//
// So the workflow's own shell is lifted out and run against a throwaway git
// repo. A restatement of the logic could not catch it drifting; this can.
describe("the gitleaks scan range (#2969)", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "gitleaks.yml"),
    "utf8"
  );

  // The snippet between the two markers is the range decision and nothing else:
  // no gitleaks binary, no network, no $RUNNER_TEMP.
  const START = 'log_opts="--all"';
  const END = 'echo "gitleaks range:';
  const start = workflow.indexOf(START);
  const end = workflow.indexOf(END);
  const snippet = workflow
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");

  const tmp = makeTmpDir("gitleaks-range");
  const sh = (args: string[]) =>
    spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(tmp, "a.txt"), "base\n");
  sh(["add", "-A"]);
  sh(["commit", "-qm", "base"]);
  const baseSha = sh(["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(tmp, "a.txt"), "head\n");
  sh(["commit", "-qam", "head"]);
  const headSha = sh(["rev-parse", "HEAD"]).stdout.trim();

  function rangeFor(env: Record<string, string>) {
    const r = spawnSync(
      "bash",
      ["-c", `set -uo pipefail\n${snippet}\necho "RANGE=$log_opts"`],
      {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          GITLEAKS_EVENT: "",
          GITLEAKS_BASE_SHA: "",
          GITLEAKS_BASE_REF: "",
          GITLEAKS_PUSH_BEFORE: "",
          ...env,
        },
      }
    );
    return { range: /RANGE=(.*)/.exec(r.stdout)?.[1] ?? "", out: r.stdout };
  }

  it("lifted a range decision out of the workflow at all", () => {
    // If the markers stop matching, every assertion below would pass vacuously.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(snippet).toContain("GITLEAKS_EVENT");
  });

  it("scans the PR RANGE on a pull request, not every ref", () => {
    const { range } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      GITLEAKS_BASE_SHA: baseSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(range).toBe(`${baseSha}..HEAD`);
    expect(range).not.toContain("--all");
  });

  it("scans the range on a merge_group commit too — the queue validates a branch", () => {
    const { range } = rangeFor({
      GITLEAKS_EVENT: "merge_group",
      GITLEAKS_BASE_SHA: baseSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(range).toBe(`${baseSha}..HEAD`);
  });

  it("scans only the commits added by a push", () => {
    const { range } = rangeFor({
      GITLEAKS_EVENT: "push",
      GITLEAKS_PUSH_BEFORE: baseSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(range).toBe(`${baseSha}..HEAD`);
  });

  it("uses the base branch when a new branch push has no previous tip", () => {
    const { range, out } = rangeFor({
      GITLEAKS_EVENT: "push",
      GITLEAKS_PUSH_BEFORE: "0000000000000000000000000000000000000000",
      GITLEAKS_BASE_REF: baseSha,
    });
    expect(range).toBe(`${baseSha}..HEAD`);
    expect(out).toContain("::warning");
    expect(out).toContain("not the previous tip");
  });

  it.each(["schedule", "workflow_dispatch"])(
    "scans every ref for an explicit %s repository-wide audit",
    (event) => {
      const { range } = rangeFor({ GITLEAKS_EVENT: event });
      expect(range).toBe("--all");
    }
  );

  it("falls back to the base REF when the base sha is missing", () => {
    const { range } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      GITLEAKS_BASE_SHA: "",
      GITLEAKS_BASE_REF: baseSha, // stands in for a resolvable ref
    });
    expect(range).toBe(`${baseSha}..HEAD`);
  });

  it("fails CLOSED to --all when no base resolves, and says so out loud", () => {
    // Under-scanning is the mistake nobody notices. An unresolvable base means
    // scan everything and warn, never scan less than advertised.
    const { range, out } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      GITLEAKS_BASE_SHA: "0000000000000000000000000000000000000000",
      GITLEAKS_BASE_REF: "origin/no-such-branch",
    });
    expect(range).toBe("--all");
    expect(out).toContain("::warning");
    expect(out).toContain("fell back to --all");
  });

  // ZERO COMMITS EXITS GREEN (#3000). Measured with the pinned binary: an empty
  // range reports 0 findings and status 0 while the branch's secret is still
  // there. Every other under-scan at least still scans something; this one is
  // the narrowest possible and it is indistinguishable from a clean branch.
  it("does not scan an EMPTY range — it warns and scans everything instead", () => {
    const { range, out } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      // The base has advanced to HEAD: resolvable, and the range it names is
      // empty. Reachable after the branch's commits land in the base.
      GITLEAKS_BASE_SHA: headSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(range).toBe("--all");
    expect(out).toContain("::warning");
    expect(out).toContain("contains no commits");
  });

  it("still scans a range that has commits in it, rather than counting everything as empty", () => {
    // The guard above must not swallow the normal path — a range with commits
    // stays a range.
    const { range, out } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      GITLEAKS_BASE_SHA: baseSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(range).toBe(`${baseSha}..HEAD`);
    expect(out).not.toContain("::warning");
  });

  // The header lists a force-pushed base among the things that must not happen
  // quietly. The code takes the base BRANCH in that case, which is a real base
  // and a defensible one — but it is not the commit the PR was built on, so it
  // is announced. Before #3000 the two documents disagreed and this case was
  // the silent one.
  it("announces when the base SHA is gone and the base BRANCH stood in", () => {
    const { range, out } = rangeFor({
      GITLEAKS_EVENT: "pull_request",
      GITLEAKS_BASE_SHA: "0000000000000000000000000000000000000000",
      GITLEAKS_BASE_REF: baseSha, // stands in for a resolvable base branch
    });
    expect(range).toBe(`${baseSha}..HEAD`);
    expect(out).toContain("::warning");
    expect(out).toContain("not the one this pull request was built on");
  });

  it("stays silent on the normal path, so a warning still means something", () => {
    const { out } = rangeFor({
      GITLEAKS_EVENT: "push",
      GITLEAKS_PUSH_BEFORE: baseSha,
      GITLEAKS_BASE_REF: "origin/main",
    });
    expect(out).not.toContain("::warning");
  });
});
