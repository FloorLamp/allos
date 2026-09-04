import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  closingKeywordHits,
  EXIT,
  KEYWORDS,
} from "../../scripts/orchestration/closing-keywords.mjs";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts",
  "orchestration",
  "closing-keywords.mjs"
);

describe("closing keyword syntax", () => {
  it("reports every supported keyword and keeps issue identity", () => {
    const text = KEYWORDS.map(
      (keyword, index) => `${keyword.toUpperCase()} #${100 + index}`
    ).join("\n");
    expect(closingKeywordHits(text, "fixture")).toEqual(
      KEYWORDS.map((keyword, index) => ({
        issue: String(100 + index),
        where: "fixture",
        phrase: `${keyword.toUpperCase()} #${100 + index}`,
      }))
    );
  });

  it("reports a negated phrase because GitHub does not parse English intent", () => {
    expect(closingKeywordHits("It does not close #3489.", "PR body")).toEqual([
      {
        issue: "3489",
        where: "PR body",
        phrase: "close #3489",
      },
    ]);
  });

  it("does not promote references or partial keyword words", () => {
    expect(
      closingKeywordHits(
        "Refs #3489. Disclosure #10. fixed-width #11. resolve later #12.",
        "fixture"
      )
    ).toEqual([]);
  });
});

const STUB_GH = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  args,
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
}) + "\\n");
const endpoint = args[args.length - 1];
if (process.env.STUB_MODE === "auth-failure") {
  process.stderr.write("authentication required\\n");
  process.exit(4);
}
if (process.env.STUB_MODE === "invalid-json") {
  process.stdout.write("proxy error page");
  process.exit(0);
}
const emit = (value) => process.stdout.write(JSON.stringify(value));
if (/\\/pulls\\/3655$/.test(endpoint)) {
  emit({
    body: process.env.STUB_MODE === "empty"
      ? "Refs #3489."
      : "It does not close #3489.\\nRefs #3655."
  });
} else if (/\\/pulls\\/3655\\/commits\\?per_page=100$/.test(endpoint)) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) process.exit(8);
  emit(process.env.STUB_MODE === "empty"
    ? [[]]
    : [[{ sha: "abcdef012345", commit: { message: "Fixed #3660" } }]]);
} else if (/\\/issues\\/3489$/.test(endpoint)) {
  emit({ state: "open", title: "unfinished phone target" });
} else if (/\\/issues\\/3660$/.test(endpoint)) {
  emit({ state: "open", title: "gh auth boundary" });
} else {
  process.stderr.write("unhandled endpoint: " + endpoint + "\\n");
  process.exit(9);
}
`;

function runCommand(mode = "success") {
  const dir = makeTmpDir("closing-keywords-cli");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), STUB_GH, { mode: 0o755 });
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(log, "");
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  const run = spawnSync(process.execPath, [SCRIPT, "3655"], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      STUB_LOG: log,
      STUB_MODE: mode,
    },
  });
  const calls = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          ghToken: string | null;
          githubToken: string | null;
        }
    );
  return { ...run, calls };
}

describe("closing-keywords command/auth boundary", () => {
  it("uses gh-auth-only API reads and reports body plus paginated commits", () => {
    const run = runCommand();
    expect(run.status).toBe(EXIT.closes);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("PR #3655 WOULD CLOSE 2 issue(s)");
    expect(run.stdout).toContain('PR body: "close #3489"');
    expect(run.stdout).toContain('commit abcdef01: "Fixed #3660"');
    expect(run.calls).toHaveLength(4);
    expect(run.calls.every((call) => call.args[0] === "api")).toBe(true);
    expect(
      run.calls.every(
        (call) => call.ghToken === null && call.githubToken === null
      )
    ).toBe(true);
    expect(run.calls.flatMap((call) => call.args).join(" ")).not.toMatch(
      /token|authorization/i
    );
  });

  it.each([
    ["auth-failure", "gh api failed"],
    ["invalid-json", "invalid JSON"],
  ])("fails closed on %s", (mode, message) => {
    const run = runCommand(mode);
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stdout).not.toContain("nothing closes");
    expect(run.stderr).toContain("cannot determine closing issues");
    expect(run.stderr).toContain(message);
  });

  it("prints the safe result only after valid empty API responses", () => {
    const run = runCommand("empty");
    expect(run.status).toBe(EXIT.nothingCloses);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("PR #3655: nothing closes on merge.\n");
    expect(run.calls).toHaveLength(2);
  });

  it("fails closed on a missing PR number", () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("usage:");
    expect(run.stdout).not.toContain("nothing closes");
  });
});
