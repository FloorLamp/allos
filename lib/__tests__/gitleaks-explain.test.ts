import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotationFor,
  classifyCommit,
  escapeAnnotation,
  escapeAnnotationProperty,
  explainCommit,
  explainReport,
  // @ts-expect-error - plain .mjs, no types
} from "../../scripts/gitleaks-explain.mjs";

// Guard for the gitleaks failure explainer (#2949), in the repo's source-scan
// idiom — filesystem only, no DB, no network.
//
// The defect it fixes is a MESSAGE, not a scan: `--log-opts="--all"` over a
// full-history checkout reads every ref pushed to the repository, so one
// branch's credential-shaped fixture reds `gitleaks` on every open PR and names
// a file the PR never touched. The explainer's whole job is to say which ref the
// finding came from and that a deletion commit will not clear it. If either
// sentence goes missing the check is back to being unreadable, which is exactly
// the state nothing else would notice.

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
    expect(classifyCommit({ onHead: true, onBase: true, commit: "a" })).toBe("base");
  });

  it("calls a commit on the head but not the base this branch's", () => {
    expect(classifyCommit({ onHead: true, onBase: false, commit: "a" })).toBe("branch");
  });

  it("calls a commit unreachable from the head another ref's", () => {
    expect(classifyCommit({ onHead: false, onBase: false, commit: "a" })).toBe("elsewhere");
  });

  it("does not attribute a finding that carries no commit", () => {
    expect(classifyCommit({ onHead: false, onBase: false, commit: "" })).toBe("unknown");
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
    const text = explainCommit(info({ kind: "branch" }), [finding], { baseLabel });
    expect(text).toContain("Introduced by this branch");
    expect(text).toMatch(/DELETES the line does NOT clear it/);
    expect(text).toMatch(/amend|rebase/);
  });

  it("tells a base finding it was not introduced here and a rebase will not help", () => {
    const text = explainCommit(info({ kind: "base" }), [finding], { baseLabel });
    expect(text).toContain("already in origin/main");
    expect(text).toContain("rebasing will not remove it");
  });

  it("groups every finding of one commit under that commit's explanation", () => {
    const second = { ...finding, File: "lib/__tests__/other.test.ts", StartLine: 7 };
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
    const text = explainReport([[info(), [finding]]], { baseLabel, truncated: 3 });
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
    expect(workflow).toMatch(/gitleaks git --log-opts="--all" --redact/);
  });

  it("still exits with gitleaks' own status, so explaining cannot become passing", () => {
    expect(workflow).toContain('status=$?');
    expect(workflow).toContain('exit "$status"');
  });

  it("gives the explainer a base ref, without which every merge-commit finding reads as new", () => {
    expect(workflow).toContain("GITLEAKS_BASE_REF:");
  });
});
