import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  claimedIssueRefusal,
  issueClaims,
  unreadableClaimRefusal,
} from "../../scripts/orchestration/dispatch-brief.mjs";

// ONE BUG, ONE LANE — HELD BY THE TOOL, NOT BY REMEMBERING (#5108).
//
// Nothing between reading an issue and writing a dispatch looked at the
// `Dispatched:` claim that was already sitting on it. Twice in three hours on
// 2026-09-04 two orchestrators dispatched onto one bug, both times by someone
// who knew the rule: on #5091 the claim was read and filtered out of a `sed`
// pipe, on #5125 no claim was written at all.
//
// The path that matters most here is the SECOND one — a claim that cannot be
// FETCHED. It is the one that will actually be hit (rate limit, proxy blip, a
// token without read) and the one that fails open if nobody writes it, so it
// is driven through the script below and not only through the predicate.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/dispatch-brief.mjs");

const MINE = "dispatch-claim-refusal-5108";
const claim = (branch: string) =>
  `Dispatched: B, branch \`${branch}\`, ordinary slot.\n\nPremise checked.`;
const at = "2026-09-04T15:18:42Z";
const comments = (...bodies: string[]) => ({
  comments: bodies.map((body) => ({ at, body })),
});

describe("issueClaims — whose claim is it, keyed on the BRANCH not the author", () => {
  // Both orchestrators post as one account, so the author cannot separate
  // them. A claim names the branch it dispatched; `new --branch X` is about to
  // create X; so a claim naming X is this dispatch's own, posted by the
  // convention that says claim before briefing.
  it.each([
    [
      comments(claim("live-practice-self-complete-5091")),
      "claimed",
      "another lane's branch",
    ],
    [comments(claim(MINE)), "clear", "my own claim, posted before briefing"],
    [
      comments("Landed by PR #5101, squashed to `38e36a85`."),
      "clear",
      "prose that is not a claim",
    ],
    [comments(), "clear", "an issue nobody has commented on"],
    [
      comments(`**Dispatched:** branch \`other-lane-1\``),
      "claimed",
      "bolded, as orchestrators write it",
    ],
    [
      comments(claim(MINE), claim("other-lane-2")),
      "claimed",
      "mine plus somebody else's",
    ],
    [{ unknown: "API rate limit exceeded" }, "unknown", "comments unreadable"],
  ])("%#: %s", (got, verdict, _why) => {
    expect(issueClaims(["5108"], MINE, () => got)[0].verdict).toBe(verdict);
  });

  it("quotes the claim and its timestamp, because a refusal must be checkable", () => {
    const rows = issueClaims(["5091"], MINE, () =>
      comments(claim("live-practice-self-complete-5091"))
    );
    const refusal = claimedIssueRefusal(rows);
    expect(refusal).toContain("#5091 was claimed 2026-09-04T15:18:42Z");
    expect(refusal).toContain("live-practice-self-complete-5091");
    expect(refusal).toContain("--adopt-claim");
    expect(
      claimedIssueRefusal(issueClaims(["5108"], MINE, () => comments()))
    ).toBeNull();
  });

  it("refuses an UNREADABLE claim in its own words — CANNOT TELL, not CLEAR", () => {
    const rows = issueClaims(["5108"], MINE, () => ({
      unknown: "API rate limit exceeded",
    }));
    const refusal = unreadableClaimRefusal(rows);
    expect(refusal).toContain("#5108: API rate limit exceeded");
    expect(refusal).toContain("AN UNREACHABLE CLAIM IS NOT AN ABSENT ONE");
    expect(refusal).toContain("--adopt-claim");
    // The two refusals must be DISTINGUISHABLE: a fetch failure is not a claim.
    expect(claimedIssueRefusal(rows)).toBeNull();
    expect(
      unreadableClaimRefusal(issueClaims(["5108"], MINE, () => comments()))
    ).toBeNull();
  });
});

/**
 * A stub `curl` answering the issue read with `issue` and the COMMENTS read
 * with `bodies` — or, when `failComments` is set, failing the comments read
 * with that body and exit 22, which is what a rate limit or a proxy blip
 * looks like from here.
 */
function stubCurl(
  dir: string,
  opts: { bodies?: string[]; failComments?: string } = {}
): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const src = `#!${process.execPath}
const url = process.argv.at(-1);
const bodies = ${JSON.stringify(opts.bodies ?? [])};
const failComments = ${JSON.stringify(opts.failComments ?? null)};
if (url.includes("/comments")) {
  if (failComments !== null) {
    process.stdout.write(failComments);
    process.exit(22);
  }
  process.stdout.write(
    JSON.stringify(bodies.map((body) => ({ created_at: ${JSON.stringify(at)}, body })))
  );
  process.exit(0);
}
process.stdout.write(JSON.stringify({ number: 5108, state: "open", closed_at: null }));
`;
  fs.writeFileSync(path.join(bin, "curl"), src, { mode: 0o755 });
  return bin;
}

function runNew(dir: string, bin: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "new",
      "--branch",
      MINE,
      "--issues",
      "5108",
      "--priority",
      "P2",
      "--lane",
      "operator",
      ...extra,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCRATCH: dir,
        ALLOS_DISPATCH_LEDGER: path.join(dir, "ledger.jsonl"),
        GH_TOKEN: "stub token 4",
      },
    }
  );
}

/** The refusal must precede every side effect, or it only annotates. */
function wroteNothing(dir: string) {
  return [
    fs.existsSync(path.join(dir, "ledger.jsonl")),
    fs.existsSync(path.join(dir, ".roster")),
  ];
}

describe("dispatch-brief.mjs new, against an issue that may already have a lane", () => {
  it("refuses another lane's claim and writes NOTHING", () => {
    const dir = makeTmpDir("dispatch-claimed");
    const run = runNew(dir, stubCurl(dir, { bodies: [claim("other-lane-3")] }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("was claimed 2026-09-04T15:18:42Z");
    expect(run.stderr).toContain("other-lane-3");
    expect(wroteNothing(dir)).toEqual([false, false]);
  });

  it("dispatches when the only claim names THIS branch — the check discriminates", () => {
    const dir = makeTmpDir("dispatch-ownclaim");
    const run = runNew(dir, stubCurl(dir, { bodies: [claim(MINE)] }));
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("REFUSED");
    expect(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8")).toContain(
      '"status":"active"'
    );
  });

  // THE PATH THAT FAILS OPEN IF NOBODY WRITES IT. The issue read SUCCEEDS
  // here, so this isolates the claim fetch: the staleness check (#4460) still
  // warns-and-continues on its own failures, and this one still refuses.
  it("refuses when the claims cannot be FETCHED, without leaking the token", () => {
    const dir = makeTmpDir("dispatch-blindclaim");
    const run = runNew(
      dir,
      stubCurl(dir, { failComments: '{"message":"API rate limit exceeded"}' })
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("could not read the claims on");
    expect(run.stderr).toContain("API rate limit exceeded");
    expect(run.stderr).toContain("AN UNREACHABLE CLAIM IS NOT AN ABSENT ONE");
    // execFileSync's own message carries the whole command, Bearer token included.
    expect(run.stderr).not.toContain("stub token 4");
    expect(wroteNothing(dir)).toEqual([false, false]);
  });

  it("--adopt-claim overrides a stale claim, and says out loud that it did", () => {
    const dir = makeTmpDir("dispatch-adoptclaim");
    const run = runNew(
      dir,
      stubCurl(dir, { bodies: [claim("other-lane-3")] }),
      ["--adopt-claim"]
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("claim check SKIPPED");
    expect(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8")).toContain(
      '"status":"active"'
    );
  });

  it("--adopt-claim also overrides an unreadable claim — one door out, not two", () => {
    const dir = makeTmpDir("dispatch-adoptblind");
    const run = runNew(dir, stubCurl(dir, { failComments: "" }), [
      "--adopt-claim",
    ]);
    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8")).toContain(
      '"status":"active"'
    );
  });
});
