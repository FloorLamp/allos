import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  branchOwnerVerdict,
  branchPrRefusal,
  branchTrailerRefusal,
  claimedIssueRefusal,
  issueClaims,
  trailerSession,
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

// THE SAME QUESTION ABOUT A PR (#5177). The claim above guards the ISSUE. On
// 2026-09-04 the collision came through the branch instead: a fix round
// dispatched onto #5139, three commits pushed onto the other session's open
// PR, and every ledger check CLEAR because that branch was never this
// session's lane. The discriminator cannot be the branch (both sessions name
// it) or the author (one account) — it is the session footer in the PR body.
describe("branchPrRefusal — whose landing slot is this branch", () => {
  const SELF = "session_0000000000000000000001";
  const OTHER = "session_0000000000000000000002";
  const BRANCH = "live-practice-self-complete-5091";
  const pr = (session: string | null, ref = BRANCH, number = 5139) => ({
    number,
    head: { ref },
    body: session
      ? `Summary.\n\n_Generated by [Claude Code](https://claude.ai/code/${session})_`
      : "Summary.",
  });

  it("refuses a branch that heads the other session's open PR", () => {
    const refusal = branchPrRefusal([pr(OTHER)], BRANCH, SELF);
    expect(refusal).toContain("REFUSED");
    expect(refusal).toContain("#5139");
    expect(refusal).toContain(OTHER);
    // The same escape, spelled the same way, as the issue claim's (#5152).
    expect(refusal).toContain("--adopt-claim");
  });

  it("clears a branch heading this session's own PR", () => {
    expect(branchPrRefusal([pr(SELF)], BRANCH, SELF)).toBeNull();
  });

  it("clears a branch that heads no open PR at all", () => {
    expect(
      branchPrRefusal([pr(OTHER, "some-other-branch")], BRANCH, SELF)
    ).toBeNull();
  });

  // A PR with no footer is not attributable to another session, so it is not
  // this predicate's refusal — the CALLER says out loud what it examined, and
  // the merge gate asks the same question again before anything lands.
  it("clears an unmarked PR rather than guessing at it", () => {
    expect(branchPrRefusal([pr(null)], BRANCH, SELF)).toBeNull();
  });

  it("clears when the running session is unknown", () => {
    expect(branchPrRefusal([pr(OTHER)], BRANCH, null)).toBeNull();
  });
});

// THE SAME QUESTION, ABOUT A BRANCH NO OPEN PR ANSWERS FOR (#5179).
//
// `branchPrRefusal` above reads the session footer in an OPEN PR's body, and
// returns null whenever no open PR heads the branch — which on this repo is
// most branches, because banked work is branch-only by design (#5220's census
// counted 70 remote branches with no open PR, only 14 of which introduce zero
// files against their merge base). A closed PR and a body that lost its footer
// land in the same silence. The commit trailer
// answers for all three, and the refusal says WHICH reader answered, because a
// caller cannot act on "refused" without knowing whether to go and read a PR.
describe("trailerSession / branchTrailerRefusal — whose work is on this branch", () => {
  const SELF = "session_0000000000000000000001";
  const OTHER = "session_0000000000000000000002";
  const BRANCH = "banked-no-pr-5220";
  const trailer = (session: string) =>
    `Claude-Session: https://claude.ai/code/${session}`;
  const commit = (subject: string, session?: string) =>
    [
      subject,
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      ...(session ? [trailer(session)] : []),
    ].join("\n");
  const mergeCommit =
    "Merge remote-tracking branch 'origin/main' into a branch";

  it.each([
    [commit("Bank the fix", OTHER), OTHER, "another session's branch"],
    [commit("Bank the fix", SELF), SELF, "this session's own branch"],
    [mergeCommit, null, "a branch with no trailer at all"],
    [null, null, "nothing read"],
    // NEWEST FIRST, so the FIRST trailer is the newest one — and a `git merge
    // origin/main` commit signs nothing, so it falls through to the work
    // underneath rather than reading as an unowned branch.
    [
      [mergeCommit, commit("Bank the fix", OTHER)].join("\n"),
      OTHER,
      "a merge commit on top of another session's work",
    ],
    [
      [commit("Round two", SELF), commit("Round one", OTHER)].join("\n"),
      SELF,
      "the newest signature wins over an older one",
    ],
    // The guard's SILENCE on its benign neighbours: this repo's commit
    // messages quote refusals and each other, and a quotation is indented.
    [
      `Say why the guard refused\n\n    ${trailer(OTHER)}`,
      null,
      "a quoted, indented trailer is a quotation, not a signature",
    ],
    [
      `Refuse a branch whose trailer names ${OTHER}`,
      null,
      "a session id in the prose is not a trailer",
    ],
  ])("%#: %s", (messages, named, _why) => {
    expect(trailerSession(messages)).toBe(named);
    const refusal = branchTrailerRefusal(messages, BRANCH, SELF);
    if (named === OTHER) {
      expect(refusal).toContain("REFUSED");
      expect(refusal).toContain(OTHER);
      // WHICH READER ANSWERED, and the alternative rather than the bare wrong.
      expect(refusal).toContain("COMMIT TRAILER did (#5179)");
      expect(refusal).toContain("COMMENT the finding");
      expect(refusal).toContain("--adopt-claim");
    } else {
      expect(refusal).toBeNull();
    }
  });

  it("clears when the running session is unknown", () => {
    expect(
      branchTrailerRefusal(commit("Bank the fix", OTHER), BRANCH, null)
    ).toBeNull();
  });
});

// TWO READERS, TWO POPULATIONS, IN ORDER (#5179). The PR body is the authority
// when it has one; the trailer answers only where it does not.
describe("branchOwnerVerdict — which reader answered, and what it cost", () => {
  const SELF = "session_0000000000000000000001";
  const OTHER = "session_0000000000000000000002";
  const BRANCH = "banked-no-pr-5220";
  const owned = `Bank it\n\nClaude-Session: https://claude.ai/code/${OTHER}`;
  const pr = (session: string, ref = BRANCH, number = 5139) => ({
    number,
    head: { ref },
    body: `Summary.\n\n_Generated by [Claude Code](https://claude.ai/code/${session})_`,
  });
  const reads = (
    prsRead: { prs: object[] } | { unknown: string },
    own:
      | { messages: string; ref: string }
      | { absent: string }
      | { unknown: string },
    onRead: () => void = () => {}
  ) => ({
    readPrs: () => prsRead,
    readOwnCommits: () => {
      onRead();
      return own;
    },
  });
  const own = { messages: owned, ref: `origin/${BRANCH}` };

  it("refuses on the trailer when NO open PR heads the branch — the gap #5177 leaves", () => {
    const { refusal, notes } = branchOwnerVerdict(
      BRANCH,
      SELF,
      reads({ prs: [pr(OTHER, "some-other-branch")] }, own)
    );
    expect(refusal).toContain("COMMIT TRAILER did (#5179)");
    expect(refusal).toContain(OTHER);
    expect(notes.join("\n")).toContain("the PR bodies did not answer");
  });

  it("does not consult the trailer when the PR body already answered", () => {
    let reads_ = 0;
    const { refusal, notes } = branchOwnerVerdict(
      BRANCH,
      SELF,
      reads({ prs: [pr(SELF)] }, own, () => reads_++)
    );
    expect([refusal, reads_]).toEqual([null, 0]);
    expect(notes.join("\n")).toContain("whose body names this session (#5177)");
  });

  // AND IT MUST NOT SAY WHY THE PR BODIES WERE SILENT. Three worlds reach this
  // refusal — no open PR heads the branch, the one that does has no footer, and
  // the list could not be read — and only the third is invisible to the trailer.
  // A refusal that enumerated the first two would send a reader looking for a PR
  // that may well exist, which is the harm naming the deciding reader prevents.
  it("still asks the trailer when the PR list could not be read at all", () => {
    const { refusal, notes } = branchOwnerVerdict(
      BRANCH,
      SELF,
      reads({ unknown: "API rate limit exceeded" }, own)
    );
    expect(refusal).toContain(OTHER);
    expect(refusal).toContain("the [pr-owner] line above says what was read");
    expect(refusal).not.toContain("no open PR heads it");
    // The line it defers to is printed, and it names the failure.
    expect(notes.join("\n")).toContain("API rate limit exceeded");
    expect(notes.join("\n")).toContain("[pr-owner] CANNOT TELL");
  });

  // #4460's posture, inherited from `branchPrRefusal`: this runs on EVERY
  // dispatch, so a read that FAILED warns and continues rather than costing
  // every lane its start — but it must never read as a pass.
  it.each([
    [{ unknown: "`git ls-remote origin refs/heads/x` failed" }, "CANNOT TELL"],
    [
      { absent: "every commit on it is already in origin/main" },
      "no unlanded commit",
    ],
  ])(
    "%#: a fallback that could not answer WARNS, never refuses",
    (read, said) => {
      const { refusal, notes } = branchOwnerVerdict(
        BRANCH,
        SELF,
        reads({ prs: [] }, read)
      );
      expect(refusal).toBeNull();
      expect(notes.join("\n")).toContain(said);
      expect(notes.join("\n")).not.toContain("REFUSED");
    }
  );

  it("asks NEITHER reader when the host exposes no session id", () => {
    let prsRead = 0;
    let ownRead = 0;
    const { refusal, notes } = branchOwnerVerdict(BRANCH, null, {
      readPrs: () => {
        prsRead++;
        return { prs: [] };
      },
      readOwnCommits: () => {
        ownRead++;
        return own;
      },
    });
    expect([refusal, prsRead, ownRead]).toEqual([null, 0, 0]);
    expect(notes.join("\n")).toContain("UNCHECKED");
  });
});
