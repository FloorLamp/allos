import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// WHAT THE BODY WRITER'S REQUESTS DECLARE — pinned as DATA, by comparing the
// argv handed to `curl`, never by making a request (#5758).
//
// The defect this file exists for: the PATCH went out with `--data-binary` and a
// JSON string but no `Content-Type`, so curl defaulted to
// `application/x-www-form-urlencoded` and the write was refused with HTTP 415 —
// "Request bodies must declare Content-Type: application/json" — before it
// reached the issue. Reproduced 2026-09-10 against a nonexistent issue number:
// without the header, 415 from the proxy; with it, 404 from GitHub, i.e. the
// request got through.
//
// WHY THE ASSERTION IS A STRING COMPARISON AND NOT A ROUND TRIP. A test that
// asserted a live write returned 2xx WOULD PASS TODAY AGAINST A SCRIPT WITH NO
// `Authorization` HEADER AT ALL: the agent proxy credentials writes from this
// container, so a junk token, the legacy `token` scheme and no header whatsoever
// were all accepted (measured on #5758's own labels endpoint, three writes, all
// 200). A live 2xx is the emptiest possible control here — it cannot fail — and
// the 415 happened in the first place because nothing could see what the request
// actually declared. So the stub curl below LOGS ITS WHOLE ARGUMENT LIST and the
// expectations are `toEqual` over that list: deleting any header, reordering the
// list, or changing a single character reds this file.
//
// `./reconcile-apply-script.test.ts` drives the same script for its BEHAVIOUR
// (the pre-write save, the blanking guard); this file is only about what goes on
// the wire.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BODY_WRITER = path.join(
  REPO,
  "scripts/orchestration/issue-body-write.ts"
);
const TSX = path.join(REPO, "node_modules/.bin/tsx");

// Fixed so the expected argv is a literal: nothing here reads the container's
// real credentials or the real repo.
const TOKEN = "stub-token-5758";
const STUB_REPO = "stub-owner/stub-repo";
const ISSUE = "4321";
const URL_ = `https://api.github.com/repos/${STUB_REPO}/issues/${ISSUE}`;
const CURRENT = "the body that is already on the issue, long enough to pass";

/** Logs the FULL argv, then answers the GET and the PATCH from memory. */
const STUB_CURL = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ body: ${JSON.stringify(CURRENT)} }));
`;

/** Run the writer with the stub on PATH; return its exit and every curl argv. */
function runBodyWrite(body: string): {
  status: number | null;
  stderr: string;
  calls: string[][];
} {
  const dir = makeTmpDir("issue-body-write-argv");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(log, "");
  const file = path.join(dir, "body.md");
  fs.writeFileSync(file, body);
  const run = spawnSync(TSX, [BODY_WRITER, ISSUE, file], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      RECONCILE_REPO: STUB_REPO,
      SCRATCH: path.join(dir, "scratch"),
      STUB_LOG: log,
    },
  });
  return {
    status: run.status,
    stderr: run.stderr,
    calls: fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
  };
}

// The one header list `writeIssueBody` builds and hands to BOTH calls. Written
// out here rather than imported from the script, so the test disagrees with a
// change instead of following it.
const HEADERS = [
  "-H",
  `Authorization: Bearer ${TOKEN}`,
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "Content-Type: application/json",
];

const NEW_BODY = "a replacement body, comfortably over half the current one";

describe("issue-body-write: the arguments handed to curl", () => {
  const run = runBodyWrite(NEW_BODY);

  it("makes exactly two requests: the pre-write GET, then the PATCH", () => {
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(2);
  });

  it("the PATCH declares Content-Type: application/json", () => {
    // THE REGRESSION GUARD. `toEqual` over the whole list, so removing the
    // `Content-Type` pair — the exact state that produced the 415 — fails here
    // and names the missing strings.
    expect(run.calls[1]).toEqual([
      "-sS",
      "--fail-with-body",
      "-X",
      "PATCH",
      ...HEADERS,
      "--data-binary",
      JSON.stringify({ body: NEW_BODY }),
      URL_,
    ]);
  });

  it("the declared type matches what is actually sent: one JSON object, one field", () => {
    // The header would be a lie if the payload were not JSON, or carried more
    // than `body` — the confinement `./reconcile-tracker.test.ts` scans for.
    const patch = run.calls[1];
    expect(patch).toContain("Content-Type: application/json");
    const payload = JSON.parse(patch[patch.indexOf("--data-binary") + 1]);
    expect(payload).toEqual({ body: NEW_BODY });
  });

  it("the pre-write GET carries the same list and no body", () => {
    // One `headers` array serves both calls, which is why the fix is one line;
    // the header is inert on a request with no payload.
    expect(run.calls[0]).toEqual(["-sS", "--fail-with-body", ...HEADERS, URL_]);
    expect(run.calls[0]).not.toContain("--data-binary");
    expect(run.calls[0]).not.toContain("-X");
  });

  it("refuses a blanking write before it ever PATCHes", () => {
    // The guard from #5673, restated here only to show the PATCH above is
    // conditional: a refused write puts NOTHING on the wire but the GET.
    const refused = runBodyWrite("");
    expect(refused.status).toBe(1);
    expect(refused.calls).toHaveLength(1);
    expect(refused.calls[0]).toEqual([
      "-sS",
      "--fail-with-body",
      ...HEADERS,
      URL_,
    ]);
  });
});
