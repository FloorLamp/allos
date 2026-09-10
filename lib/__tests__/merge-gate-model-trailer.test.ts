// A SQUASH BODY MAY NOT CARRY A MODEL NAME (#4995).
//
// A squash merge concatenates the branch's commit messages into the squash
// body, so a lane whose environment supplied its own commit template writes a
// model identifier into main's permanent history. `96f7c30a` is that commit:
// its body is three lane commits run together, and two of the three
// `Co-Authored-By` lines name a model while the first one is correct.
//
// THE FIXTURE IS `96f7c30a`'s REAL MESSAGE, with ONE deliberate substitution:
// the model name is replaced by `Fictional 9`, which is not any model's name.
// Every other byte is the landed commit's — the concatenation, the `(#4065)`
// section headers, the correct trailer on line 30, all three `Claude-Session:`
// URLs. The substitution costs the test nothing, because the check is built NOT
// to know model names: its discriminator is the angle bracket, so `Fictional 9`
// exercises the identical branch. It buys the repository not carrying the
// identifier this change exists to keep out. The alternative — reading the
// message from git at test time — cannot work: `test-unit` checks out at the
// default depth of 1 (.github/workflows/ci.yml), where `96f7c30a` is absent.
//
// THE PERMITTING CASES ARE REAL AND VARIED, because a fixture set whose cases
// differ only in a model name would pass with the check deleted: `982f993a`'s
// whole real message, the fixture's own near-miss twin (identical body, correct
// trailers), a human co-author, and the `claude-code`/`claude.ai`/`Claude-Session`
// spellings this repo writes in ordinary prose.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { makeTmpDir } from "./tmp-dir";
import {
  COMMIT_TRAILER,
  modelIdentifierLines,
  modelTrailerVerdict,
  SESSION_TRAILER,
} from "../../scripts/orchestration/merge-gate-core.mjs";

const LANDED = fs.readFileSync(
  fileURLToPath(new URL("./__fixtures__/squash-96f7c30a.txt", import.meta.url)),
  "utf8"
);
// The same body with the two attribution lines corrected — the near miss the
// gate must let through, and the only difference between them.
const LANDED_CORRECTED = LANDED.replaceAll(
  "Co-Authored-By: Claude Fictional 9 <",
  "Co-Authored-By: Claude <"
);
const SHA = "96f7c30afd040dd79d3bf8d2eea13babb5c342b9";

// `982f993a` on main, verbatim: a squash whose body was supplied explicitly, so
// it carries only the merger's text. The permitting case as it actually looks.
const EXPLICIT_SQUASH = [
  "The fever row leads the summary and the Meds chip yields",
  "",
  "Refs #4712",
  "",
  COMMIT_TRAILER,
  "Claude-Session: https://claude.ai/code/session_01UMmsmTxfHSFuJMRuVHrsqb",
].join("\n");

describe("which commit messages name a model (#4995)", () => {
  it("finds both offending lines in the message that landed, and not the correct one", () => {
    expect(modelIdentifierLines(LANDED)).toEqual([
      "Co-Authored-By: Claude … <noreply@anthropic.com>",
    ]);
    // The proof that the correct line was READ and not merely absent: it is in
    // this very body, three lines above the first offender.
    expect(LANDED).toContain(COMMIT_TRAILER);
  });

  it.each([
    ["the corrected twin of the landed body", LANDED_CORRECTED],
    ["a squash body supplied explicitly", EXPLICIT_SQUASH],
    ["the trailer the dispatch brief prints", COMMIT_TRAILER],
    ["the session line the brief prints beside it", SESSION_TRAILER],
    [
      "a human co-author",
      `Subject\n\nCo-Authored-By: Ada Lovelace <ada@example.com>`,
    ],
    [
      "the spellings this repo writes in prose",
      "Generated with claude-code at https://claude.ai/code/session_01x\n" +
        "Claude-Session: https://claude.ai/code/session_01x",
    ],
    ["a message with no trailers at all", "Subject\n\nBody.\n"],
    ["an absent message", undefined],
  ])("permits %s", (_case, message) => {
    expect(modelIdentifierLines(message as string)).toEqual([]);
  });

  it.each([
    [
      "the lowercase trailer key git also accepts",
      "co-authored-by: Claude Fictional 9 <noreply@anthropic.com>",
      "co-authored-by: Claude … <noreply@anthropic.com>",
    ],
    [
      "extra whitespace around the name",
      "Co-Authored-By:  Claude   Fictional 9  <noreply@anthropic.com>",
      "Co-Authored-By:  Claude … <noreply@anthropic.com>",
    ],
    [
      "a bare model id in prose",
      "Move the run to claude-fictional-9 for the summary",
      "Move the run to claude-… for the summary",
    ],
  ])("refuses %s", (_case, message, redacted) => {
    expect(modelIdentifierLines(message)).toEqual([redacted]);
  });

  // The refusal is republished by .github/workflows/merge-gate.yml as the
  // `merge-gate` commit status description, so a refusal quoting the offending
  // line would push the identifier to the repository under the gate's own name.
  it("never repeats the identifier it refuses", () => {
    const verdict = modelTrailerVerdict([{ sha: SHA, message: LANDED }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).not.toContain("Fictional");
    expect(verdict.message).toContain("96f7c30a");
    expect(verdict.message).toContain(COMMIT_TRAILER);
    expect(verdict.message).toContain(SESSION_TRAILER);
  });

  it("names every offending commit, and not the clean ones", () => {
    const verdict = modelTrailerVerdict([
      { sha: SHA, message: LANDED },
      { sha: "1111111122222222333333334444444455555555", message: EXPLICIT_SQUASH },
      {
        sha: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee",
        message: `Subject\n\nCo-Authored-By: Claude Fictional 9 <noreply@anthropic.com>`,
      },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("2 of 3 commit(s)");
    expect(verdict.message).toContain("96f7c30a");
    expect(verdict.message).toContain("aaaaaaaa");
    expect(verdict.message).not.toContain("11111111");
  });

  it("opens on a branch carrying only correct trailers", () => {
    const verdict = modelTrailerVerdict([
      { sha: SHA, message: LANDED_CORRECTED },
      { sha: "1111111122222222333333334444444455555555", message: EXPLICIT_SQUASH },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toBe("2 commit message(s) name no model");
  });

  // A guard may not fail into its permissive answer: GitHub lists at most 250
  // commits on a PR, and the unlisted ones are the case this check exists for.
  it("refuses rather than passing on a listing it could not read to the end", () => {
    const verdict = modelTrailerVerdict(
      [{ sha: SHA, message: EXPLICIT_SQUASH }],
      { truncated: true }
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("UNREAD");
    expect(verdict.message).toContain(COMMIT_TRAILER);
  });
});

// THE WIRING, not the verdict: a perfect core the CLI never calls refuses
// nothing. These runs drive the real script against a stubbed curl, and the
// only difference between them is what `/pulls/12/commits` answers.
describe("merge-gate.mjs reads the PR's commits (#4995)", () => {
  const SCRIPT = fileURLToPath(
    new URL("../../scripts/orchestration/merge-gate.mjs", import.meta.url)
  );
  const HEAD = "477cd8a1afd4ff38afb33ff7c9b1de5fd380fb31";
  const bin = makeTmpDir("merge-gate-model-trailer");
  afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(bin, "pr.json"),
    JSON.stringify({
      number: 12,
      state: "open",
      draft: false,
      title: "A title the gate accepts",
      body: "",
      user: { login: "someone" },
      head: { sha: HEAD, ref: "a-branch" },
      base: { ref: "main" },
    })
  );

  const run = (message: string) => {
    fs.writeFileSync(
      path.join(bin, "commits.json"),
      JSON.stringify([{ sha: SHA, commit: { message } }])
    );
    const curl = path.join(bin, "curl");
    fs.writeFileSync(
      curl,
      `#!/bin/sh
case "$*" in
  *graphql*) printf '{}\\n403' ;;
  *compare*) printf '{"merge_base_commit":{"sha":"${HEAD}"},"total_commits":0,"commits":[],"files":[]}\\n200' ;;
  *pulls/12/commits*) cat ${JSON.stringify(path.join(bin, "commits.json"))}; printf '\\n200' ;;
  *reviews*|*comments*|*/files*) printf '[]\\n200' ;;
  *check-runs*) printf '{"total_count":1,"check_runs":[{"id":1,"name":"a-check","status":"completed","conclusion":"success"}]}\\n200' ;;
  */status*) printf '{"state":"success","statuses":[]}\\n200' ;;
  *pulls/12*) cat ${JSON.stringify(path.join(bin, "pr.json"))}; printf '\\n200' ;;
  *) printf '{}\\n200' ;;
esac
`
    );
    fs.chmodSync(curl, 0o755);
    return spawnSync(
      process.execPath,
      [SCRIPT, "12", "--repo", "owner/name", "--session", "session_0test12"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "test",
          PATH: `${bin}:${process.env.PATH}`,
        },
      }
    );
  };

  it("closes on a commit whose message names a model, redacting it", () => {
    const gate = run(LANDED);
    expect(gate.stdout).toContain("FAIL: 1 of 1 commit(s) name a model");
    expect(gate.stdout).toContain("96f7c30a");
    expect(gate.stdout).toContain(COMMIT_TRAILER);
    expect(`${gate.stdout}\n${gate.stderr}`).not.toContain("Fictional");
    expect(gate.stdout).toContain("GATE CLOSED");
  });

  // The same run, one substitution apart: the check that refuses everything is
  // not a check, and this is where that would show.
  it("passes the same body once its trailers are correct", () => {
    const gate = run(LANDED_CORRECTED);
    expect(gate.stdout).toContain("PASS: 1 commit message(s) name no model");
    expect(gate.stdout).not.toContain("name a model:");
  });
});
