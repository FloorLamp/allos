// Pure verdicts for merge-gate.mjs. The CLI owns GitHub reads and process exits;
// this module owns decisions so their full matrix does not need a fresh process.
//
// ONE EXCEPTION, AT THE BOTTOM: `prepareHeadTree` and its neighbours DO touch
// git and the filesystem (#5710). They live here rather than in the CLI for the
// reason every other verdict does — merge-gate.mjs cannot be imported, so
// anything that lands there is testable only by running the gate against a live
// PR, and the rule this machinery has to obey (a failed fetch stays a DECLINE,
// never a clean row) is exactly the kind that needs its failure branches
// exercised. Nothing here runs at import: the git runner and the fs module are
// parameters with defaults, so the module stays side-effect-free to load.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ASSERTS_INDEPENDENCE =
  /\b(?:did not|didn'?t)\s+(?:author|write)\b|\bindependent(?:ly)?\s+review/i;

// A HEDGED CLAIM IS NOT A CLAIM. "I could not establish that I did not author
// this" contains the phrase and says the opposite of it, and widening the
// pattern to catch more spellings is exactly what would let that sentence in
// (#5166). This is the only direction the normalisation below can go wrong, so
// it is checked per SENTENCE rather than per body.
const HEDGED =
  /\b(?:could\s+not|couldn'?t|cannot|can'?t|unable\s+to|was\s+not\s+able|no\s+way\s+to)\b/i;

// Markdown, removed rather than matched around. `*`, `_` and `` ` `` are the
// decoration a person adds to STRESS the load-bearing word — `I did **not**
// author this change` is the natural way to write the receipt's key sentence,
// and it carries the literal bytes `did **not** author` (#5166). Deleting the
// characters is safe in the one direction that matters: none of them is a word
// separator, so removing them can join `did`+`not` back into `did not` but can
// never turn an identifier like `did_not_author` into the phrase.
const unemphasise = (text) => text.replace(/[`*_]/g, "");

/** Sentences, over normalised text — the unit a claim is judged in. */
const sentences = (text) =>
  unemphasise(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

// ── WHAT COUNTS AS QUOTATION (#5183) ────────────────────────────────────────
//
// ONE splitter for both readers below, because "is this line speaking, or is it
// showing you what somebody else said" is one question, and two answers to it
// is a second convention to remember. #5183 is what the second answer cost: the
// receipt reader dropped a blockquote and the marker reader did not, so a PR
// comment explaining the marker grammar — with its examples in a fenced block,
// the shape anyone documenting anything reaches for — placed a live hold and a
// stale pass verdict on two unrelated PRs. The grammar could not be written
// down on the surface it is read from, including in the reviews this gate asks
// for.
//
// A line QUOTES when it sits inside a ``` or ~~~ fence, inside an indented code
// block, or behind a `>`. Every other line SPEAKS.
//
// BLOCKQUOTES QUOTE, and that is the ruling #5183 left open rather than the
// inheritance. The case for reading them was that a blockquoted hold relaying
// somebody else's hold is still a hold. Two things settle it the other way. A
// marker is not only a brake — a pass verdict OPENS a merge — so a reader that
// honours quoted markers lets anybody quote a pass into existence, the exact
// forgery `independenceClaim` drops a quoted claim to prevent. And GitHub's own
// "Quote reply" blockquotes the comment it answers under a NEW timestamp, while
// markers are newest-wins: quoting a long-lifted hold would re-place it. A
// relayed hold is one keystroke away from a placed one; a forged pass is not
// recoverable at all.
//
// AN UNTERMINATED FENCE RUNS TO THE END OF THE BODY. That is CommonMark's rule
// and therefore what the writer SEES rendered on GitHub; the alternative —
// reading an unpaired ``` as ordinary text — would re-arm every example under
// it. But a parser that swallows the rest of a comment in silence is its own
// way to lose a real hold, so nothing here is silent: both readers keep the
// marker-shaped lines they skipped, and SAY that they skipped them.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * A body's lines, split into the ones that speak and the ones that quote.
 *
 * @param {string} body
 * @returns {{ asserting: string[], quoting: string[] }}
 */
function speechLines(body) {
  const asserting = [];
  const quoting = [];
  let fence = null;
  let indented = false;
  let paragraph = false;
  for (const raw of String(body ?? "").split("\n")) {
    if (fence) {
      quoting.push(raw);
      const close = FENCE.exec(raw);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        !close[2].trim()
      )
        fence = null;
      continue;
    }
    const opener = FENCE.exec(raw);
    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length };
      quoting.push(raw);
      indented = paragraph = false;
      continue;
    }
    if (!raw.trim()) {
      asserting.push(raw);
      paragraph = false;
      continue;
    }
    if (/^\s*>/.test(raw)) {
      quoting.push(raw);
      indented = paragraph = false;
      continue;
    }
    // An indented code block cannot interrupt a paragraph, by CommonMark and by
    // what GitHub renders — so a continued or wrapped line that happens to be
    // indented still speaks. Only an indent that STARTS a block is code.
    if (INDENTED_CODE.test(raw) && (indented || !paragraph)) {
      quoting.push(raw);
      indented = true;
      continue;
    }
    asserting.push(raw);
    indented = false;
    paragraph = true;
  }
  return { asserting, quoting };
}

/**
 * Does this review body ASSERT that its writer did not author the change?
 *
 * Quoting lines are dropped before the test — blockquoted, fenced, or indented
 * as code (#5183): a receipt that quotes somebody else's independence claim, or
 * shows one as an example, is reporting one rather than making it. Hedged
 * sentences are dropped too. `why` names which of those swallowed the only
 * candidate, so the refusal can say "your markdown ate the phrase" rather than
 * leaving the writer to guess — the second cost #5166 records.
 *
 * @param {string} body
 * @returns {{ asserts: boolean, why: null | "quoted" | "hedged" }}
 */
export function independenceClaim(body) {
  const { asserting, quoting } = speechLines(body);
  const own = asserting.join("\n");
  if (
    sentences(own).some((s) => ASSERTS_INDEPENDENCE.test(s) && !HEDGED.test(s))
  )
    return { asserts: true, why: null };
  if (sentences(own).some((s) => ASSERTS_INDEPENDENCE.test(s)))
    return { asserts: false, why: "hedged" };
  return {
    asserts: false,
    why: sentences(quoting.join("\n")).some((s) => ASSERTS_INDEPENDENCE.test(s))
      ? "quoted"
      : null,
  };
}

// ── THE COMMIT TRAILER, IN ONE PLACE (#4995) ────────────────────────────────
//
// A squash merge concatenates the branch's commit messages into the squash
// body, so whatever a lane wrote in a trailer becomes main's permanent history.
// `96f7c30a` landed two `Co-Authored-By` lines naming a model that way — beside
// a correct one in the same body — and nothing between the lane and the merge
// looked at it. The dispatch brief STATED the correct trailer in prose, and
// prose is what drifts, so the trailer is a value here: dispatch-brief.mjs
// interpolates these two lines into every brief and the verdict below refuses
// against them. One string, two readers, the shape title-rule.mjs already has.
export const COMMIT_TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

// The session line the brief requires beside it. It is a URL and names no
// model, which is exactly why the refusal below must not fire on it: a pattern
// reading `Claude-` as the opening of an identifier would refuse every
// conforming commit in this repo.
export const SESSION_TRAILER = "Claude-Session: <session URL>";

// The brief's whole trailer instruction, so the STATEMENT of the rule sits with
// the constant and with the check that enforces it rather than in a third copy.
// dispatch-brief.mjs prints this verbatim; nothing about the brief a lane reads
// changes by living here.
export const COMMIT_TRAILER_BRIEF = `- Commit trailers for a Claude session, the second holding the real URL:
    ${COMMIT_TRAILER}
    ${SESSION_TRAILER}
  Other harnesses follow their own attribution instructions; never invent a
  session. No model identifier in pushed content — merge-gate.mjs refuses a
  commit whose message names one.`;

// WHAT IS REFUSED — ONE SHAPE, and deliberately no list of model names. An
// enumeration goes stale the day a new name exists, and a stale enumeration
// fails into a silent pass, which is the one direction a guard may not fail.
//
// A `Co-Authored-By` whose `Claude` is followed by anything but the address.
// The discriminator is the ANGLE BRACKET, not the word before it, so this knows
// no model's name: `Co-Authored-By: Claude <noreply@…>` is the correct trailer
// and opens the gate, while a name sitting where no name belongs closes it. Git
// reads a trailer key case-insensitively and both spellings are in this
// history, so this reads it that way too.
//
// WHAT IS NOT REFUSED, stated because a guard's blind spots are part of its
// contract: a model's marketing name in prose with no `Co-Authored-By` around
// it, another vendor's id, and a co-author line naming a model without the word
// `Claude`. Catching any of those needs the list of names this refuses to keep.
//
// A SECOND SHAPE IS AVAILABLE AND NOT SHIPPED (PM ruling, 2026-09-10): a bare
// model id, `claude-` then segments of which one is numeric, the numeral being
// what separates an id from `claude-code` and `Claude-Session`. It is out
// because nothing has ever exhibited it — measured 2026-09-10, 22 offending
// lines across the five open branches and main's last 60 commits, every one of
// them the shape above — while `lib/ai-client.ts` and `lib/ai-tiers.ts` hold
// real ids as production config, so it would refuse an honest commit message
// naming one. That is a fact about today. REVISIT ON THE FIRST OBSERVED
// INSTANCE: the pattern is `/\bclaude-(?:[a-z]+-)*\d[\w.]*/i`, and it needs a
// second `redact` clause so the refusal still does not repeat what it refuses.
const MODEL_ATTRIBUTION =
  /^[^\S\n]*co-authored-by:[^\S\n]*claude[^\S\n]+(?=[^<\s])[^\n]*/gim;

// THE REFUSAL MAY NOT REPEAT WHAT IT REFUSES. merge-gate.mjs's first failure
// becomes the `merge-gate` commit status description, which the workflow POSTS
// to GitHub — so a refusal quoting the offending line would publish the model
// name it exists to keep out, on the repository, under this gate's own name.
// The shape is what the writer needs to see anyway; the identifier is not.
const redact = (line) =>
  line.replace(/(co-authored-by:[^\S\n]*claude)[^\S\n]+[^<\n]*/i, "$1 … ");

/** The model-naming lines one commit message carries, redacted to their shape. */
export function modelIdentifierLines(message) {
  const lines = new Set();
  for (const [line] of (message ?? "").matchAll(MODEL_ATTRIBUTION))
    lines.add(redact(line.trim()));
  return [...lines];
}

/**
 * Whether the messages that will be concatenated into the squash body name a
 * model. `commits` are `{ sha, message }`; `truncated` says GitHub's listing
 * was capped, which REFUSES rather than passing on the part it could read —
 * unread commits are the case this check exists for.
 */
export function modelTrailerVerdict(commits, { truncated = false } = {}) {
  const offenders = commits
    .map((commit) => ({
      sha: (commit.sha ?? "").slice(0, 8) || "an unnamed commit",
      lines: modelIdentifierLines(commit.message),
    }))
    .filter((commit) => commit.lines.length);
  if (offenders.length)
    return {
      ok: false,
      message:
        `${offenders.length} of ${commits.length} commit(s) name a model: ` +
        `${offenders.map((o) => `${o.sha} (${o.lines.join(", ")})`).join(", ")}` +
        `. A squash concatenates these into the body that lands on main, so ` +
        `reword each one; the trailer is exactly "${COMMIT_TRAILER}" with ` +
        `"${SESSION_TRAILER}" under it (#4995)`,
    };
  if (truncated)
    return {
      ok: false,
      message:
        "cannot tell whether these commits name a model — GitHub lists at " +
        "most 250 commits on a PR and this one filled that, so the rest went " +
        "UNREAD. Shorten the branch or read them by hand; the trailer is " +
        `exactly "${COMMIT_TRAILER}" (#4995)`,
    };
  return {
    ok: true,
    message: `${commits.length} commit message(s) name no model`,
  };
}

export function readinessVerdict(pr) {
  const failures = [];
  if (pr.state !== "open") {
    failures.push(`PR is ${pr.merged ? "merged" : pr.state}`);
  }
  if (pr.draft) {
    failures.push(
      "PR is DRAFT — PRs open READY (environment.md §GitHub access)"
    );
  }
  return { failures, ready: !pr.draft };
}

/** Every SHA-shaped token a review body states, in the order it states them. */
const shasStated = (body) =>
  [...String(body ?? "").matchAll(/[0-9a-f]{8,40}/g)].map((match) => match[0]);

export function receiptVerdict(pr, reviews, head = pr.head.sha) {
  const statesHead = (body) =>
    shasStated(body).some((sha) => head.startsWith(sha));
  const receiptShaped = (review) =>
    ["COMMENTED", "APPROVED"].includes(review.state) && statesHead(review.body);
  const receipt = reviews.find(
    (review) => review.user?.login !== pr.user?.login && receiptShaped(review)
  );
  const sharedReceipt = receipt
    ? null
    : reviews.find(
        (review) =>
          review.user?.login === pr.user?.login &&
          receiptShaped(review) &&
          independenceClaim(review.body).asserts
      );
  if (receipt) {
    return {
      ok: true,
      message: `exact-head receipt: ${receipt.user.login} states ${head.slice(0, 8)}`,
    };
  }
  if (sharedReceipt) {
    return {
      ok: true,
      message:
        `exact-head receipt (shared identity): ${sharedReceipt.user.login} states ` +
        `${head.slice(0, 8)} and asserts they did not author the change`,
    };
  }

  const unasserted = reviews.find(
    (review) => review.user?.login === pr.user?.login && receiptShaped(review)
  );
  const swallowed = unasserted ? independenceClaim(unasserted.body).why : null;
  const staleReceipt = reviews.find(
    (review) =>
      review.user?.login !== pr.user?.login &&
      /[0-9a-f]{8,40}/.test(review.body ?? "")
  );
  // A review that is a receipt in EVERY respect except which commit it states
  // (#4994). Whether one of those commits is an ancestor of this head with an
  // identical three-dot diff is a question about git, not about review bodies,
  // so this pure function only names the candidates; merge-gate.mjs has the
  // reads and calls `mergeInReceipt` with them. The independence rules are
  // applied HERE and not again there: a candidate is a non-author review, or
  // the PR's own account asserting it did not author the change (#4258).
  const ancestorCandidates = reviews
    .filter(
      (review) =>
        ["COMMENTED", "APPROVED"].includes(review.state) &&
        (review.user?.login !== pr.user?.login ||
          independenceClaim(review.body).asserts)
    )
    .map((review) => ({
      who: review.user?.login ?? "an unnamed reviewer",
      shared: review.user?.login === pr.user?.login,
      shas: shasStated(review.body).filter((sha) => !head.startsWith(sha)),
    }))
    .filter((candidate) => candidate.shas.length)
    // NEWEST FIRST, because the caller caps how many it will read for: the
    // latest review is the one most likely to be the receipt, and on a PR with
    // a long review history the oldest are the least likely to still describe
    // this change. The cap only ever costs a pass, never grants one.
    .reverse();
  return {
    ok: false,
    ancestorCandidates,
    message: unasserted
      ? `a review by the PR's own account states ${head.slice(0, 8)} but does ` +
        "not assert independence — on a shared identity the receipt must SAY " +
        "the reviewer did not author the change (#4258); re-post the review " +
        "with that statement" +
        (swallowed === "quoted"
          ? ". The only such sentence here QUOTES — BLOCKQUOTED, fenced, or " +
            "indented as code — and quoting somebody else's claim is " +
            "reporting one, not making one"
          : swallowed === "hedged"
            ? '. The only such sentence here is HEDGED ("could not", ' +
              '"unable to") — that sentence says the opposite of the claim'
            : "")
      : staleReceipt
        ? `no receipt for ${head.slice(0, 8)} — the head changed since ` +
          `${staleReceipt.user.login}'s review, which VOIDS it; re-review this head`
        : "no exact-head receipt: no review states this head SHA",
  };
}

// ── A RECEIPT THAT SURVIVES A MAIN MERGE-IN (#4994) ─────────────────────────
//
// Merging `origin/main` into a branch moves the head without changing the
// change, and the exact-head rule above voids the receipt anyway. On
// 2026-09-03 that cost four reviews, every one of them re-given on a diff that
// had not moved a byte. So a receipt at an ANCESTOR of the head still counts
// when the PR's three-dot diff is the same at the reviewed commit and at the
// head. This is the only place the gate is LESS strict than exact-head, and
// the failure it can cause is a change merging on a review nobody gave — so
// every branch here refuses unless it can positively see sameness.
//
// THE HUNK-OFFSET AND INDEX-LINE DECISION, WHICH IS TO NORMALISE BOTH.
// A unified diff carries two fields that address text rather than state it:
// the `@@` START LINE NUMBERS, and the abbreviated blob ids on `index` lines.
// Both move when main grows above a hunk or touches the same file elsewhere,
// with nothing about the PR changing. Measured on this repository's own PRs:
//   · #5702 — `@@ -410,9 +408,7 @@` became `@@ -418,9 +416,7 @@` and
//     `@@ -325,9 +325,7 @@` became `@@ -333,9 +333,7 @@`, same counts, same
//     section heading, same body: main had grown eight lines above.
//   · #5803 — the two compares printed the SAME blobs at different
//     abbreviation lengths, `89cc43fff5..7baabf2b0c` against
//     `89cc43fff..7baabf2b0`. Nothing differed but how many characters git
//     chose to show, and it chose differently for two ranges of one repository.
// That second one is why verbatim is not merely the stricter option: it makes
// the verdict turn on a rendering width no one controls, which is arbitrary
// rather than conservative. Over 90 real merge-in PRs read on 2026-09-11,
// verbatim found 58 unchanged, normalising found 63, and the 27 that carried
// real edits stayed different under both.
//
// WHAT IS NOT NORMALISED, and is the reason this is safe: the hunk LINE COUNTS,
// the text after the second `@@`, the `--- `/`+++ ` paths, the mode and
// new-file/deleted-file lines, and every `+`, `-` and context line, all
// verbatim. Each of those is a function of what the PR does, so one line of
// content different changes at least one of them and the gate refuses.
//
// THE LIMIT THIS LEAVES, DEMONSTRATED AND OPEN. Dropping start offsets cannot
// distinguish a hunk that MOVED from one that did not. Git's section heading —
// kept verbatim here — defeats the easy version, because a block relocated past
// a declaration lands under a different heading. It does NOT defeat a block
// relocated WITHIN one heading: built on a real repository 2026-09-11, a long
// array literal under one `export const TABLE = [`, with the PR's added row
// moved from one repeated seven-line group to another, produces two three-dot
// diffs that differ only in `@@ -13` against `@@ -34` and the blob id. This
// function reads them as identical, and the tree genuinely changed. It needs no
// merge-in at all.
// It is REPORTED, not closed. The discriminator that would close it is
// available for the price of one field: `compare/{reviewed}...{head}` is
// already read here for ancestry, and in a real merge-in every commit it lists
// is a merge — a relocation needs an ordinary content commit, or a conflict
// resolution, and neither is what #4994 ruled on. That is a narrowing of the
// ruling, so it is a decision to take rather than one to slip in.
const HUNK_HEADER = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;
const INDEX_LINE = /^index [0-9a-f]{4,40}\.\.[0-9a-f]{4,40}/;

export const DIFF_NORMALISED = "hunk start offsets and index blob ids";

/**
 * A unified diff with its ADDRESSING blanked and its content untouched.
 * Only a header line can match: content lines all carry a `+`, `-` or space.
 */
export function normaliseDiff(diff) {
  return String(diff ?? "")
    .split("\n")
    .map((line) =>
      HUNK_HEADER.test(line)
        ? line.replace(
            HUNK_HEADER,
            (_match, oldCount = "", newCount = "") =>
              `@@ -_${oldCount} +_${newCount} @@`
          )
        : INDEX_LINE.test(line)
          ? line.replace(INDEX_LINE, "index _.._")
          : line
    )
    .join("\n");
}

/**
 * DID THE HEAD MOVE WITHOUT THE CHANGE MOVING? The question on its own,
 * separated from what any one caller does with the answer.
 *
 * ONE CALLER TODAY: `mergeInReceipt`, below. The gate holds a SECOND head-bound
 * mark that goes stale on the same merge-in for the same reason — the
 * falsifying pass, whose own refusal says the head change "VOIDS it exactly as
 * it voids a receipt" — and it deliberately does NOT call this. #4994 ruled on
 * the receipt only. The falsifying pass is a SAFETY gate, MANDATORY on the
 * paths where the stakes are highest, and relaxing it is a ruling to be taken
 * rather than a symmetry to be noticed: if it is taken, this is the call site
 * to add, not a second derivation of the same judgement.
 *
 * @param {object} input
 * @param {string} input.head the PR head SHA
 * @param {string} input.reviewed the earlier SHA the mark states, resolved
 * @param {string} input.baseRef the branch this PR merges into
 * @param {object|null} input.ancestry `compare/{reviewed}...{head}`, or null if
 *   the read failed — its `merge_base_commit` IS the ancestry answer
 * @param {string|null} input.reviewedDiff three-dot diff at the earlier commit,
 *   taken against THAT commit's own merge base with `baseRef`
 * @param {string|null} input.headDiff the same, at the head
 * @returns {{same: boolean, kind: string, why: string}} `why` is one clause,
 *   written to follow "the head moved, but ..." — the caller supplies the
 *   framing, because what the answer MEANS depends on what it is answering for.
 */
export function contentFreeSince({
  reviewed,
  head,
  baseRef = "main",
  ancestry,
  reviewedDiff,
  headDiff,
}) {
  const between = `${shortSha(reviewed)} and ${shortSha(head)}`;
  // ANCESTRY FIRST, and from the comparison's own merge base rather than from
  // the commit appearing in some listing: a mark on an abandoned or
  // force-pushed line of history names a commit that is no longer on the way
  // to this head, and what it records is a tree nobody will merge.
  if (!ancestry)
    return {
      same: false,
      kind: "unreadable-ancestry",
      why: `whether ${shortSha(reviewed)} is an ancestor of ${shortSha(head)} could not be read`,
    };
  if (ancestry.merge_base_commit?.sha !== reviewed)
    return {
      same: false,
      kind: "not-ancestor",
      why:
        `${shortSha(reviewed)} is NOT an ancestor of ${shortSha(head)} — that ` +
        "is a line of history this head left behind (force-pushed or " +
        "abandoned), not the change that would merge",
    };
  if (typeof reviewedDiff !== "string" || typeof headDiff !== "string")
    return {
      same: false,
      kind: "unreadable-diff",
      why: `the three-dot diff at ${shortSha(reviewed)} or at ${shortSha(head)} could not be read`,
    };
  // An empty diff matches an empty diff, which would make any ancestor with
  // nothing in it stand for everything. There is nothing there to have seen.
  if (!/^diff --git /m.test(reviewedDiff))
    return {
      same: false,
      kind: "empty-diff",
      why:
        `${shortSha(reviewed)}'s three-dot diff against ${baseRef} is EMPTY — ` +
        "an empty diff is not evidence of anything",
    };
  if (normaliseDiff(reviewedDiff) !== normaliseDiff(headDiff))
    return {
      same: false,
      kind: "changed",
      why:
        `the PR's three-dot diff against ${baseRef} CHANGED between ${between} ` +
        "— the head carries content the earlier commit did not",
    };
  return {
    same: true,
    kind: "content-free",
    why:
      `the three-dot diff against ${baseRef} — each side taken at its OWN ` +
      `merge base — is identical at ${between} (${DIFF_NORMALISED} normalised)`,
  };
}

/**
 * The #4994 acceptance itself: `contentFreeSince` worded as a receipt verdict.
 *
 * @param {object} input
 * @param {string} input.who who wrote the receipt
 * @param {boolean} [input.shared] it is the PR's own account, asserting independence
 * @param {string} input.head the PR head SHA
 * @param {string} input.reviewed the SHA the receipt states, resolved
 * @param {string} [input.baseRef] the branch this PR merges into
 * @param {object|null} input.ancestry as `contentFreeSince` takes it
 * @param {string|null} input.reviewedDiff as `contentFreeSince` takes it
 * @param {string|null} input.headDiff as `contentFreeSince` takes it
 * @returns {{ok: boolean, kind: string, message: string}}
 */
export function mergeInReceipt({ who, shared = false, ...evidence }) {
  const answer = contentFreeSince(evidence);
  const { reviewed, head, baseRef = "main" } = evidence;
  if (!answer.same)
    return {
      ok: false,
      kind: answer.kind,
      message:
        `${who}'s receipt states ${shortSha(reviewed)} and the head is now ` +
        `${shortSha(head)}; it stays stale because ${answer.why}`,
    };
  return {
    ok: true,
    kind: "survived",
    message:
      `receipt survives a ${baseRef} merge-in: ${who} states ` +
      `${shortSha(reviewed)}${shared ? " and asserts they did not author the change" : ""}, ` +
      `an ancestor of ${shortSha(head)}, and ${answer.why} — the #4994 acceptance`,
  };
}

// A `cancelled` run never reached a verdict, so it is not one (#4800). The
// gate was reading "never ran" as "ran and failed": a push that races the
// previous run's start leaves the cancelled run standing beside the green that
// replaced it, and counting the cancellation closed the gate on a head whose
// checks tab was green.
//
// Discarding cancellations is the whole rule. Nothing here picks a winner
// between two runs, so nothing here can mask a red: of what is left under one
// name, ALL must be green. That is the right reading of every duplicate the
// gate can actually see. GitHub's default listing already collapses each check
// SUITE to its newest run — 20 runs on #4800's head, where `filter=all` returns
// 37 — so a re-run never arrives here, and the duplicates that do are
// cross-suite, genuinely separate runs. gitleaks is the standing example: it
// fires on `pull_request` AND on branch `push`, and those scan different ranges
// (`base..HEAD` against `before..HEAD`), so requiring both is requiring both
// scans. Two workflows sharing a job name — ci.yml and ci-main.yml both define
// `check`, `test-unit` and `test-db` — would likewise both be required, rather
// than one silently standing in for the other.
export const reachedAVerdict = (run) => run.conclusion !== "cancelled";

// ── ONE COMMIT'S CI, READ FROM BOTH ENDPOINTS ───────────────────────────────
//
// A commit carries CHECK RUNS (what Actions jobs post) and COMMIT STATUSES
// (what any other reporter posts) as two DISJOINT sets on two endpoints, and
// neither endpoint mentions the other's rows. Reading one and calling the
// answer "CI" is the defect #5022 exists to remove: on PR #5319 at 12:20Z
// `/check-runs` was 19 of 19 green — `merge-gate-job` among them — while
// `/commits/<sha>/status` carried `merge-gate = failure · gate CLOSED — no
// exact-head receipt`. The two names differ by one word, so every row here
// carries its SOURCE: a bare `merge-gate` in a diagnostic is the same trap
// wearing the fix's clothes.
//
// Rows, not a verdict: the gate asks "may this merge", the watcher asks "has
// registration stopped moving", the board asks for a line per PR. A name whose
// every run was CANCELLED reaches no `state` at all and comes back in
// `noVerdict`, which asks for a re-run rather than sending anyone to hunt a
// failure that never happened.
//
/**
 * @typedef {{name: string, id?: number, status?: string,
 *   conclusion?: string|null, html_url?: string}} CheckRun
 * @typedef {{context: string, state: string, description?: string|null,
 *   target_url?: string|null}} CommitStatus
 * @typedef {{source: string, name: string,
 *   state: "pending"|"failed"|"success", detail?: string|null,
 *   url?: string|null, id?: number}} CiRow
 *
 * @param {{checkRuns?: CheckRun[], statuses?: CommitStatus[],
 *   ignoreCheck?: string|null}} input
 * @returns {{rows: CiRow[], noVerdict: string[], ignored: boolean}}
 */
export function ciRows({ checkRuns = [], statuses = [], ignoreCheck = null }) {
  const named = checkRuns.filter((run) => run.name !== ignoreCheck);
  const decided = named.filter(reachedAVerdict);
  const rows = decided.map((run) => ({
    source: "check-run",
    name: run.name,
    state:
      run.status !== "completed"
        ? "pending"
        : ["success", "neutral", "skipped"].includes(run.conclusion)
          ? "success"
          : "failed",
    detail: run.conclusion ?? run.status,
    url: run.html_url,
    // The annotations endpoint is keyed on the run id, and it is the only
    // route to a failing spec's assertion (pr-board.mjs --why says why).
    id: run.id,
  }));
  const settled = new Set(decided.map((run) => run.name));
  const noVerdict = [...new Set(named.map((run) => run.name))].filter(
    (name) => !settled.has(name)
  );
  for (const status of statuses) {
    rows.push({
      source: "status",
      name: status.context,
      state:
        status.state === "pending"
          ? "pending"
          : status.state === "success"
            ? "success"
            : "failed",
      detail: status.description || status.state,
      url: status.target_url,
    });
  }
  return {
    rows,
    noVerdict,
    ignored: Boolean(ignoreCheck && named.length !== checkRuns.length),
  };
}

/** `check-run e2e (6)` / `status merge-gate` — the endpoint, then the name. */
export const rowName = (row) => `${row.source} ${row.name}`;

// THE GATE'S OWN PUBLISHED STATUS IS NOT EVIDENCE TO THE GATE (#5022).
// .github/workflows/merge-gate.yml posts the `merge-gate` status by running
// THIS script, so a gate counting its own context reads back its own last
// answer: a `failure` posted before the receipt landed closes the gate, the
// workflow re-runs the gate, the gate reads the failure it just posted and
// posts it again — a self-block with no way out, in the one tool whose refusal
// stops every merge. It is recomputed here instead, by every other check in
// merge-gate.mjs. EVERY OTHER CONTEXT STILL COUNTS: a deploy gate or a
// coverage bot is exactly what nothing here recomputes, and ignoring one is
// how a merge goes out over a red nobody read.
export const GATE_STATUS_CONTEXT = "merge-gate";

/**
 * @param {{checkRuns?: CheckRun[], statuses?: CommitStatus[],
 *   ignoreCheck?: string|null, head: string}} input
 * @returns {{kind: "incomplete"|"fail"|"pass", ignored: boolean,
 *   message: string}}
 */
export function ciVerdict({
  checkRuns = [],
  statuses = [],
  ignoreCheck = null,
  head,
}) {
  const { rows, noVerdict, ignored } = ciRows({
    checkRuns,
    statuses,
    ignoreCheck,
  });
  const echo = (row) =>
    row.source === "status" && row.name === GATE_STATUS_CONTEXT;
  const counted = rows.filter((row) => !echo(row));
  const echoed = rows.filter(echo);
  const checks = counted.filter((row) => row.source === "check-run");
  const pending = counted.filter((row) => row.state === "pending");
  const red = counted.filter((row) => row.state === "failed");
  const recomputed = echoed.length
    ? ` This head's own \`${GATE_STATUS_CONTEXT}\` status (${echoed
        .map((row) => row.state)
        .join(
          ", "
        )}) is THIS script's last answer and is recomputed here, not read.`
    : "";
  if (checks.length === 0 || pending.length || noVerdict.length) {
    return {
      kind: "incomplete",
      ignored,
      message:
        `CI INCOMPLETE on ${head.slice(0, 8)}: ${checks.length} check run(s) ` +
        `registered, ${pending.length} pending` +
        (pending.length ? ` (${pending.map(rowName).join(", ")})` : "") +
        (noVerdict.length
          ? `, no verdict for ${noVerdict.join(", ")} (every run cancelled — re-run it)`
          : "") +
        ". Not a verdict — run ci-watch.mjs to settlement." +
        recomputed,
    };
  }
  if (red.length) {
    return {
      kind: "fail",
      ignored,
      message: `red on this head: ${red.map(rowName).join(", ")}`,
    };
  }
  return {
    kind: "pass",
    ignored,
    message:
      `all ${checks.length} check run(s) and ` +
      `${counted.length - checks.length} independent commit status(es) green ` +
      `on this head.${recomputed}`,
  };
}

export function closedStatusDescription(failure) {
  const description = `gate CLOSED — ${failure.replace(/\s+/g, " ").trim()}`;
  return description.length <= 140
    ? description
    : `${description.slice(0, 137)}...`;
}

// ── WHAT THE MAIN DETECTOR SAYS ABOUT ONE HEAD ──────────────────────────────
//
// ONE classifier, two readers. `baseDetectorNotice` states the standing beside
// a merge decision (#4722); `main-red-history.mjs` states it for a RUN of heads
// (#5160). Both ask the identical question, and a second answer to it is the
// thing that would rot: the four not-green states below are each a ruling
// (#4370 twice, #4722, and the cancelled case above), and a history tool that
// re-derived them would drift out of agreement with the gate that merges.

/**
 * The detector's standing on one head, as a VALUE rather than a sentence.
 *
 * `kind` is the whole vocabulary, and none of the four not-green states may be
 * folded into another: `unobserved` is a head the detector never ran on at all
 * (it debounces, so a burst of merges collapses to one run at the newest head),
 * `nothing-ran` is a push it ran on and skipped for having no runtime surface,
 * `cancelled` is no verdict, and `pending` is not one yet.
 *
 * @param {{name: string, status?: string, conclusion?: string|null}[]} runs
 * @param {string} detector
 * @returns {{kind: "unobserved"|"cancelled"|"red"|"pending"|"nothing-ran"|"green",
 *   detected: object[], shards: object[], red: object[], pending: object[], ran: object[]}}
 */
export function detectorStanding(runs, detector = "e2e-main") {
  const detected = runs.filter((run) => run.name.startsWith(detector));
  const shards = detected.filter(reachedAVerdict);
  const red = shards.filter(
    (run) =>
      run.status === "completed" &&
      !["success", "neutral", "skipped"].includes(run.conclusion)
  );
  const pending = shards.filter((run) => run.status !== "completed");
  // A SKIPPED SHARD IS NOT A GREEN ONE (#4370). This used to fold `skipped` in
  // with `success` and report "is green (4 shards)" over a run that executed no
  // browser at all — the exact false confidence #4370 was filed about, printed
  // at the moment a merge decision is taken.
  const ran = shards.filter((run) => run.conclusion !== "skipped");
  const kind = !shards.length
    ? detected.length
      ? "cancelled"
      : "unobserved"
    : red.length
      ? "red"
      : pending.length
        ? "pending"
        : ran.length
          ? "green"
          : "nothing-ran";
  return { kind, detected, shards, red, pending, ran };
}

// What `e2e-main` says about the branch this PR merges INTO (#4722).
//
// That workflow runs on pushes to main, so it never appears on a PR head and
// nothing in the exact-head evidence above can see it. Main was red there for
// eight consecutive merges while every PR read 19/19 green. This states the
// standing verdict beside the merge decision; it does not close the gate,
// because .github/workflows/e2e-main.yml reserves detector-to-gate as a
// separate ruling.
export function baseDetectorNotice(runs, ref, detector = "e2e-main") {
  const at = runs[0]?.head_sha ? `${ref}@${runs[0].head_sha.slice(0, 8)}` : ref;
  const { kind, shards, red, pending, ran } = detectorStanding(runs, detector);
  switch (kind) {
    case "cancelled":
      return `${detector}: no verdict on ${at} — every shard run was cancelled; re-run it`;
    case "unobserved":
      return `${detector}: no verdict on ${at} — it debounces, and skips a push with no runtime surface`;
    case "red":
      return `${detector}: ${at} is RED — ${red.map((run) => run.name).join(", ")}. Attribute it before merging onto it (#4722)`;
    case "pending":
      return `${detector}: still running on ${at} (${pending.length} of ${shards.length})`;
    case "nothing-ran":
      return `${detector}: ${at} ran NOTHING (${shards.length} shards skipped — no runtime surface in that push). Not a green; the nightly is what covers main`;
    default:
      return `${detector}: ${at} is green (${ran.length} of ${shards.length} shards ran)`;
  }
}

// ── MARKERS: THE PRECONDITIONS THAT USED TO LIVE ONLY IN PROSE ───────────────
//
// #5126. Every other precondition this gate knows is a PASS/FAIL line. The hold
// an orchestrator places while a MANDATORY falsifying pass runs was not: it was
// written into a review body and a PR comment, `merge-gate.mjs 5112` passed on
// the receipt it was waiting for, and the PR merged while the pass was still
// running. The pass came back with three CONFIRMED reproductions, which are now
// #5125 against `main` rather than against a branch. Nobody misread anything —
// the gate said what it knows, and it did not know this.
//
// So a hold and a pass verdict get the same treatment the receipt gets: a note
// on the PR, in a shape a script can read. NOT a label and NOT a draft flip
// (both ruled out in #5126): a label is not on the head, so it survives a head
// change that must void the evidence, and every PR here opens READY by rule.
//
// ONE GRAMMAR, because a second convention is a second thing to remember:
//
//   MERGE-HOLD: <reason>                 stop this merge, for the stated reason
//   MERGE-HOLD LIFTED: <reason>          release it
//   FALSIFYING-PASS: SURVIVES <sha>      the pass ran on <sha> and broke nothing
//   FALSIFYING-PASS: FALSIFIED <sha>     the pass ran on <sha> and broke it
//
// Either may be posted as a review or as a PR comment — both are where the
// #5112 hold was actually written — and the same markdown normalisation the
// receipt gets applies here, so an emphasised marker still reads. A marker that
// QUOTES does not: see the splitter above for why writing the grammar down had
// to stop placing holds (#5183).
//
// A HOLD IS NOT HEAD-BOUND AND A PASS IS. That asymmetry is the whole point of
// each: a hold that a push could lift is a hold anyone can walk through by
// pushing, and a pass verdict that survived a push would be evidence about code
// that no longer exists — the same void the receipt takes on a head change.

/**
 * The markers a note set carries: `found` newest first, and `ignored` — the
 * marker-shaped lines that QUOTE rather than speak. Those are kept rather than
 * dropped so a caller can say a marker went unread instead of going quiet about
 * it, which is the failure the fence rule would otherwise trade for (#5183).
 */
export function markerLines(notes, name) {
  const opener = new RegExp(`^${name}\\b\\s*:?\\s*`, "i");
  // The `>` here is now only reached by a quoting line — a speaking one never
  // starts with it — and stripping it is what lets a blockquoted marker be
  // RECOGNISED well enough to be reported as unread.
  const normalise = (raw) =>
    unemphasise(raw)
      .replace(/^[>\s]+/, "")
      .trim();
  const found = [];
  const ignored = [];
  for (const note of notes ?? []) {
    const { asserting, quoting } = speechLines(note.body);
    for (const raw of asserting) {
      const line = normalise(raw);
      if (!opener.test(line)) continue;
      found.push({
        line,
        rest: line.replace(opener, "").trim(),
        at: note.at ?? "",
        who: note.user ?? "someone",
      });
    }
    for (const raw of quoting) {
      const line = normalise(raw);
      if (opener.test(line))
        ignored.push({ line, who: note.user ?? "someone" });
    }
  }
  // Newest first, and a HOLD wins a tie: two markers stamped the same second
  // are not ordered by anything, and the conservative reading is the one that
  // does not open a gate on a coin flip.
  return {
    found: found.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1)),
    ignored,
  };
}

/** What to say about marker-shaped lines that quoted rather than spoke. */
const unreadNote = (ignored, name) =>
  ignored.length
    ? ` NOTE: ${ignored.length} ${name} line(s) here QUOTE — blockquoted, ` +
      `fenced, or indented as code — and were NOT read as markers (#5183). ` +
      `${ignored[0].who} wrote "${ignored[0].line}". Post it unquoted if it ` +
      "was meant as one."
    : "";

/**
 * The general hold (#5126): an orchestrator's machine-readable "not yet", for
 * any stated reason, liftable by the same convention.
 *
 * @param {{ body: string, at?: string, user?: string }[]} notes reviews and PR comments
 */
export function holdVerdict(notes) {
  const { found: marks, ignored } = markerLines(notes, "MERGE-HOLD");
  const unread = unreadNote(ignored, "MERGE-HOLD");
  if (!marks.length) return { held: false, message: unread || null };
  const newest = marks[0].at;
  const current = marks.filter((m) => m.at === newest);
  const held = current.find((m) => !/^lifted\b/i.test(m.rest));
  if (held) {
    return {
      held: true,
      message:
        `MERGE HOLD in force — ${held.who} wrote "${held.line}" at ` +
        `${held.at || "an unrecorded time"}. A hold outlives a push, by design; ` +
        'lift it with a "MERGE-HOLD LIFTED: <reason>" note when what it names is settled' +
        unread,
    };
  }
  return {
    held: false,
    message:
      `merge hold LIFTED at ${current[0].at || "an unrecorded time"} — ` +
      `"${current[0].line}"${unread}`,
  };
}

/**
 * The mandated falsifying pass (#5126), on THIS head.
 *
 * `grounds` is null when `adversarial-review-brief.mjs --check` did not say
 * MANDATORY, and the check's own grounds text when it did. The caller never
 * passes null for "the check could not be read" — that is a refusal to answer,
 * and it belongs in the CLI beside the other reads that can go dark.
 *
 * @param {{ body: string, at?: string, user?: string }[]} notes
 * @param {string} head
 * @param {string|null} grounds
 */
export function falsifyingPassVerdict(notes, head, grounds) {
  if (!grounds) return { ok: true, kind: "not-required", message: null };
  const { found: marks, ignored } = markerLines(notes, "FALSIFYING-PASS");
  const unread = unreadNote(ignored, "FALSIFYING-PASS");
  const post =
    "post the pass's own verdict as \"FALSIFYING-PASS: SURVIVES " +
    `${head.slice(0, 8)}" (or FALSIFIED) on the PR`;
  if (!marks.length) {
    return {
      ok: false,
      kind: "missing",
      message:
        `MANDATORY adversarial review and NO falsifying-pass verdict on ` +
        `${head.slice(0, 8)} — the merge waits for the pass (#5126). Grounds: ` +
        `${grounds}. When it reports, ${post}` +
        unread,
    };
  }
  const statesHead = (mark) =>
    [...mark.rest.matchAll(/[0-9a-f]{8,40}/g)].some((m) =>
      head.startsWith(m[0])
    );
  const onHead = marks.find(statesHead);
  if (!onHead) {
    return {
      ok: false,
      kind: "stale",
      message:
        `the head changed since ${marks[0].who}'s falsifying pass, which VOIDS ` +
        `it exactly as it voids a receipt — re-run the pass on ${head.slice(0, 8)} ` +
        `and ${post}. The void verdict was "${marks[0].line}"` +
        unread,
    };
  }
  // The pass's OWN line, quoted rather than restated: the merger reads what the
  // falsifier wrote, not this script's paraphrase of it (#5126's acceptance).
  if (/^survives\b/i.test(onHead.rest))
    return {
      ok: true,
      kind: "survives",
      message: `falsifying pass on ${head.slice(0, 8)} — ${onHead.who}: "${onHead.line}"`,
    };
  if (/^falsified\b/i.test(onHead.rest))
    return {
      ok: false,
      kind: "falsified",
      message:
        `the falsifying pass FALSIFIED this head — ${onHead.who}: "${onHead.line}". ` +
        "Fix each refuted claim; a fix that changes the MECHANISM earns a fresh pass",
    };
  return {
    ok: false,
    kind: "unreadable",
    message:
      `a falsifying-pass note states ${head.slice(0, 8)} but says neither ` +
      `SURVIVES nor FALSIFIED: "${onHead.line}". A verdict this gate cannot ` +
      "read is not a verdict — re-post it in the documented shape",
  };
}

// ── WHOSE PR IS THIS? (#5177) ───────────────────────────────────────────────
//
// Two orchestrator sessions run against this repo and post as ONE GitHub
// account, so `pr.user.login` cannot separate them — the same problem #4258
// solved for the receipt and #5152 solved for the issue claim, arriving a third
// time on the PR itself. On 2026-09-04 this cost two of the other session's PRs
// merged by this one and three commits pushed onto a third: every ledger check
// said CLEAR, correctly, because the branches were never in this session's
// ledger. The one marker that exists is the session link the PR body's footer
// already carries, and nothing read it.
//
// The null case is NOT a pass. A PR with no session link — an older one, a
// human-authored one — is a DISTINCT outcome from a PR belonging to the other
// session, and this says which of the two it saw rather than folding them into
// one silence.

// THE ATTRIBUTION IS A URL, AND PROSE IS NOT A URL (#5254).
//
// This read `\bsession_([A-Za-z0-9]+)` over the whole body and took the FIRST
// match, and a body is prose long before it is a trailer. #5252 explained what
// the check-in stamps — the literal words `.boot_id` and `.session_id` — so the
// gate took `session_id` for the owning session and refused this session's own PR
// as another's. The remedy it then offered is `--adopt-pr`, the deliberate
// override for the collision #5177 exists to prevent: a check that cries wolf and
// then hands you the flag that silences it teaches the flag.
//
// AND THE QUIET DIRECTION IS THE WORSE ONE. First-match also fails OPEN — a body
// whose prose names the RUNNING session above a trailer naming another one read as
// `mine` and PASSED, which is #5177's own catastrophe with the guard printing a
// pass over it. Four bodies in the window below (#5236, #5240, #5248, #5265) carry
// a bare id in prose above their trailer; all four happen to agree with it, which
// is luck rather than a property of the reader.
//
// So the id is taken from a POSITION, in the #5183 shape rather than as a list of
// contexts to ignore. The trailer line is read first: it is generated, it is last,
// and nothing a writer quotes can occupy it. Otherwise the last `claude.ai/code`
// session URL in the body — because a sentence about `session_id` cannot be a URL
// however it is quoted, while a lane that writes its session only as the bare
// commit-trailer link is still ATTRIBUTED rather than dropping to the "unmarked"
// note that #5177 must not be softened into.
//
// BOTH TIERS ARE LOAD-BEARING on real traffic, and neither is a length rule or a
// guess about wording. Over PRs #4144-#5282, 217 resolve on the trailer line and
// 17 on the fallback — every one of those 17 (e.g. #5203, #5127) carries
// `_Generated by [Claude Code](https://claude.ai/code)_` with no id in it. Across
// all 600 the new reader answers exactly what the old one did; what changes is the
// bodies neither of them has met yet.
const TRAILER_SESSION =
  /^\s*_Generated by \[Claude Code\]\(https:\/\/claude\.ai\/code\/session_([A-Za-z0-9]+)\)_\s*$/;
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_([A-Za-z0-9]+)/g;

/** The session id a PR body's trailer names, or null. */
export function bodySession(body) {
  const text = String(body ?? "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trailer = TRAILER_SESSION.exec(lines[i]);
    if (trailer) return `session_${trailer[1]}`;
  }
  const url = [...text.matchAll(SESSION_URL)].pop();
  return url ? `session_${url[1]}` : null;
}

/**
 * The running session's own id, from whatever the host actually offers. The
 * remote host spells it `cse_<id>` where the PR footer spells it
 * `session_<id>`; the id is the same string and only the prefix differs.
 */
export function normaliseSession(raw) {
  if (!raw) return null;
  const id = /(?:session_|cse_)([A-Za-z0-9]+)/.exec(String(raw))?.[1];
  return id ? `session_${id}` : null;
}

/**
 * @param {{ body?: string | null }} pr
 * @param {string|null} self the running session, already normalised
 * @param {boolean} adopted whether --adopt-pr was passed
 */
export function ownershipVerdict(pr, self, adopted = false) {
  const marked = bodySession(pr.body);
  if (!self)
    return {
      kind: "unverifiable",
      severity: "note",
      message:
        "PR OWNERSHIP UNCHECKED — this host exposes no session id, so the " +
        `body's ${marked ? `${marked} ` : "(absent) "}footer cannot be compared ` +
        "to anything. Pass --session <id> to check it (#5177)",
    };
  if (!marked)
    return {
      kind: "unmarked",
      severity: "note",
      message:
        "PR OWNERSHIP UNKNOWN — this body carries no session link, which is " +
        "what an older or human-authored PR looks like. Not a confirmation " +
        "that it is yours; confirm before merging (#5177)",
    };
  if (marked === self)
    return {
      kind: "mine",
      severity: "pass",
      message: `PR belongs to this session (${self})`,
    };
  return {
    kind: "other",
    severity: adopted ? "note" : "fail",
    message: adopted
      ? `ADOPTED another session's PR: the body names ${marked}, this session ` +
        `is ${self} (#5177). You have taken that decision deliberately`
      : `this PR belongs to ANOTHER session — its body names ${marked}, this ` +
        `session is ${self}. Two writers on one landing slot is what the ` +
        "cross-session protocol exists to prevent (#5177). Reviewing, gating " +
        "and merging it takes that session's control of its own landing slot. " +
        "Pass --adopt-pr if the two sessions have actually agreed",
  };
}

// HAS ANYTHING CHECKED THE TREE THAT WILL LAND? (#5235)
//
// #5129 made `kind` required on `TimezoneSwitch`. #5138's CI went green against
// a base that predated it. No textual conflict, both merged clean, and `main`
// was red on `check`, `seed` and `build` for two merges until #5148 cleared it.
// Each tree typechecks clean ON ITS OWN BASE; only the merged tree is invalid,
// which is why no per-branch check of any kind could have seen it.
//
// CI checks `head` merged with `main` as main stood at the head's CI base. When
// main has moved since, the tree that will land is one nothing has checked, and
// the only evidence that somebody checked it is a receipt from whoever did.
//
// ── THE LIMIT THIS TAKES ON, and it is a PATH rule ──────────────────────────
//
// "A merge that touched lib/ or a type/contract" is the ruling's trigger, and
// half of it is not decidable from paths: whether a diff moves a type is a
// question for the checker. That is landing-independence.mjs's documented blind
// spot (#5138) and no better path list closes it. So this does not try to
// decide it. It asks the decidable question — COULD this merge have moved a
// type — and a path can answer that: a file the TypeScript program compiles,
// anything under lib/, or the dependency and compiler contracts. Docs,
// markdown, workflows and plain .mjs tooling cannot change a type verdict, and
// are the only merges that pass without a receipt.
//
// The refusal SAYS this, because a reader has to know what the gate did not
// check: it never opens a file, so a contract carried somewhere other than a
// TypeScript type — a JSON schema, a stored SQL shape, a generated manifest —
// is outside it unless the merge also touched a path above.

/** A path a merge could move a type or a compile contract through. */
const TYPE_BEARING = [
  /^lib\//,
  /\.(?:ts|tsx|mts|cts)$/,
  /^package(?:-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
];

export const typeBearing = (paths) =>
  (paths ?? []).filter((p) => TYPE_BEARING.some((re) => re.test(p))).sort();

// ── THE ESCAPE, AND WHY IT IS TOKENS RATHER THAN PROSE ──────────────────────
//
// The receipt states that the MERGED tree was checked and NAMES THE COMMANDS.
// Reading a claim out of a body is the hazard #5254 is about, so nothing here
// interprets a sentence: the receipt is read for four literals — the head SHA,
// the base SHA it merged, `npm run typecheck`, and a test script's own name.
// It carries the merge-gate marker grammar, so a QUOTED receipt does not count,
// for the reason a quoted pass verdict does not (#5183).
//
//   MERGED-TREE-CHECKED: <head> onto <main> — npm run typecheck; npm run test:db
//
// AND THE GATE DOES NOT JUDGE WHETHER THE COMMANDS WERE ENOUGH. It checks that
// they were named and which two commits they were run against; whether the
// tiers named cover the diff is the writer's claim, and the refusal says so.
export const RECEIPT_MARKER = "MERGED-TREE-CHECKED";

const NAMES_TYPECHECK = /npm run typecheck/;
const NAMES_A_TEST_TIER = /npm (?:run )?test/;

const shortSha = (sha) => String(sha ?? "").slice(0, 8);
const states = (text, sha) =>
  [...String(text ?? "").matchAll(/[0-9a-f]{8,40}/g)].some((m) =>
    String(sha ?? "").startsWith(m[0])
  );

const howToPost = (head, baseTip) =>
  `post "${RECEIPT_MARKER}: ${shortSha(head)} onto ${shortSha(baseTip)} — ` +
  'npm run typecheck; npm run test:db" on the PR, with the commands you ' +
  "actually ran";

/**
 * @param {object} input
 * @param {string} input.head the PR head SHA
 * @param {string} input.baseRef the branch this PR merges into
 * @param {string|null} input.baseTip that branch's current tip
 * @param {string|null} input.ciBase merge base of head and baseRef — the CI base
 * @param {{sha: string, subject: string}[]} input.landed what baseRef gained since
 * @param {string[]} input.landedFiles the paths those commits touched
 * @param {boolean} input.truncated the comparison did not fit one page
 * @param {{line: string, rest: string, who: string, at: string}[]} input.marks
 *   receipt markers, newest first, already stripped of quoted ones
 * @param {string} input.unread what to say about marker lines that quoted
 * @returns {{ok: boolean, kind: string, message: string}}
 */
export function baseMovedVerdict({
  head,
  baseRef = "main",
  baseTip,
  ciBase,
  landed = [],
  landedFiles = [],
  truncated = false,
  marks = [],
  unread = "",
}) {
  // A gate that cannot tell must refuse: a base-moved check that fails open
  // licenses the merge it was written to question.
  if (truncated || !ciBase || !baseTip)
    return {
      ok: false,
      kind: "unreadable",
      message:
        `cannot tell how far ${shortSha(head)} is behind ${baseRef} — the ` +
        (truncated
          ? "comparison did not fit one page"
          : "comparison did not answer") +
        ". Re-run the gate; if it stays unreadable, merge main into the head " +
        "and let CI re-run, which needs no comparison to be right",
    };

  if (!landed.length)
    return {
      ok: true,
      kind: "current",
      message: `CI base IS ${baseRef}@${shortSha(baseTip)} — nothing landed since${unread}`,
    };

  const moved = typeBearing(landedFiles);
  const behind = `${shortSha(head)} is ${landed.length} merge(s) behind ${baseRef}@${shortSha(baseTip)} (CI base ${shortSha(ciBase)})`;
  if (!moved.length)
    return {
      ok: true,
      kind: "inert",
      message:
        `${behind}, and none of them touched lib/ or a file the compiler ` +
        `reads: ${landed.map((c) => shortSha(c.sha)).join(", ")}${unread}`,
    };

  const why =
    `${behind}, and ${moved.length} of the paths they changed could move a ` +
    `type or a compile contract (${moved.slice(0, 4).join(", ")}` +
    `${moved.length > 4 ? `, +${moved.length - 4} more` : ""}). Each tree can ` +
    "typecheck clean on its own base and still be invalid merged (#5129/#5138), " +
    "so nothing on either head answers this";
  // BOTH LIMITS, IN THE REFUSAL ITSELF. A reader who is about to post a receipt
  // needs to know what a PASS from this gate is worth: it never opens a file,
  // and it never decides whether the tiers named were the right ones.
  const limit =
    " The trigger is PATHS: whether a diff really moves a type is the " +
    "checker's question, so a contract carried outside a TypeScript file is " +
    "not covered here. Nor does this judge whether the tiers you name cover " +
    "the diff — it checks that they were named.";

  if (!marks.length)
    return {
      ok: false,
      kind: "missing",
      message: `${why}. Merge ${baseRef} into the head and let CI re-run, or ${howToPost(head, baseTip)}.${limit}${unread}`,
    };

  const onHead = marks.find((m) => states(m.rest, head));
  if (!onHead)
    return {
      ok: false,
      kind: "stale-head",
      message:
        `the head changed since ${marks[0].who}'s merged-tree check, which ` +
        `VOIDS it exactly as it voids a receipt — re-check and ${howToPost(head, baseTip)}. ` +
        `The void receipt was "${marks[0].line}"${unread}`,
    };
  if (!states(onHead.rest, baseTip))
    return {
      ok: false,
      kind: "stale-base",
      message:
        `${marks[0].who}'s merged-tree check names ${shortSha(head)} but not ` +
        `${baseRef}@${shortSha(baseTip)}, so it is a check of some OTHER merged ` +
        `tree — ${baseRef} has moved since. Re-check against the current tip and ` +
        `${howToPost(head, baseTip)}. The stale receipt was "${onHead.line}"${unread}`,
    };
  const named = [];
  if (!NAMES_TYPECHECK.test(onHead.rest)) named.push("npm run typecheck");
  if (!NAMES_A_TEST_TIER.test(onHead.rest))
    named.push("a test tier (npm test / npm run test:db)");
  if (named.length)
    return {
      ok: false,
      kind: "unnamed-commands",
      message:
        `a merged-tree receipt states ${shortSha(head)} onto ${shortSha(baseTip)} ` +
        `but NAMES no ${named.join(" and no ")} — the ruling asks for the ` +
        "commands because a receipt nobody can check is prose. It read " +
        `"${onHead.line}"${unread}`,
    };

  return {
    ok: true,
    kind: "receipted",
    message:
      `merged tree checked for ${shortSha(head)} onto ${baseRef}@${shortSha(baseTip)} ` +
      `— ${onHead.who}: "${onHead.line}". Whether those commands cover the ` +
      "diff is their claim; this gate checked that they were named" +
      unread,
  };
}

// ── WHAT A CHANGED DERIVATION REACHES, BESIDE THE TABLE THAT CLAIMS IT (#5680) ─
//
// A converted shared derivation is only as safe as the reviewer's list of who
// consumes it, and that list was a hand-written table in the PR body. On #5645
// three careful rounds each named the NEAREST surface and stopped, while the
// value travelled further — into a tappable control that writes, a Server
// Action, the priority-1 send. #5687 made the answer derivable
// (`scripts/reach.ts`); this puts the derived answer next to the claimed one at
// the moment a merge is decided.
//
// ADVISORY, by the PM's sequencing: every row here is a NOTE and never a
// failure. The step that turns a missing row into a FAIL is the PM's to take,
// once the rows have been read against real PRs for a while.
//
// WHICH SYMBOLS. The diff is the trigger, read the way `typeBearing` reads
// paths: an exported top-level function under `lib/` (not a test tree) is a
// candidate when the diff touches its DECLARATION HUNK — a `+`/`-` line that
// declares it, or a hunk whose git function context (the text after the second
// `@@`) is its declaration, which is how a change inside the body shows up.
// The context is git's nearest-preceding-heading guess, so a hunk that only
// adds a NEW function after another's body over-reports the neighbour; that
// direction is safe. What this misses: a symbol renamed only in a barrel's
// `export { a as b }` list (no function declaration on either side), and a
// body change whose hunk's context line git resolves to something other than
// the declaration (a preceding `export interface`, a nested block that starts
// at column 0). Capped at twenty per PR, sorted, so a sweep cannot turn the
// gate into a minute per file.
//
// WHICH TABLE. A consumer table is a markdown table whose header row mentions
// consumer(s), reaches, surface or terminal, or any heading that contains
// "consumer" — read from the body's SPEAKING lines (#5183), as every other
// claim here is. A terminal is NAMED when the body mentions its path: the full
// repo-relative path, or a suffix of it two or more segments long
// (`history/page.tsx`, `notifications/tick.ts:451`), case-sensitively, anywhere
// in the body including fenced blocks — pasting the CLI's own output IS naming
// the consumers. A bare basename (`page.tsx`) names nothing.

const REACH_CAP = 20;
const DERIVATION_FILE = /^lib\/.*\.tsx?$/;
const TEST_TREE = /(^|\/)__(?:tests|db_tests|action_tests)__\//;
// `export function f(` / `export async function f(` / `export const f =` (or
// `export const f: T =`), at the start of a changed line or of git's hunk context.
const DECLARES =
  /^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const HUNK_CONTEXT = /^@@[^@]*@@ ?(.*)$/;

const declared = (text) => {
  const m = DECLARES.exec(text);
  return m ? (m[1] ?? m[2]) : null;
};

// A column-0 `}`, `)` or `]` closes a prettier-formatted top-level declaration.
const TOP_LEVEL_CLOSER = /^[})\]]/;

/**
 * The changed declaration at `lines[i]`, whitespace-normalised: its own side
 * of the hunk from the declaring line through the column-0 closer, or up to
 * the next blank or column-0 line. Lines from the hunk's other side are
 * skipped; a context line, hunk header or the patch's end ends the text.
 */
const declarationText = (lines, i) => {
  const sign = lines[i][0];
  const out = [];
  for (let j = i; j < lines.length; j++) {
    const line = lines[j];
    if (line[0] !== sign) {
      if (line[0] === "+" || line[0] === "-") continue;
      break;
    }
    const code = line.slice(1);
    const closes = TOP_LEVEL_CLOSER.test(code);
    if (j > i && !closes && (!code.trim() || /^\S/.test(code))) break;
    out.push(code.trim().replace(/\s+/g, " "));
    if (j > i && closes) break;
  }
  return out.join("\n");
};

/**
 * The `{file, symbol, added}` triples whose declaration hunk a PR's patches
 * touch, sorted, deduplicated. `files` is `GET /pulls/N/files`: `filename`,
 * `status`, `patch` (absent for a binary or an oversized diff, which
 * contributes nothing). A declaration removed from one file and added
 * verbatim to another file of the same PR is a move, not a change, and is
 * dropped from both (#5710); a moved body with any other line changed stays.
 * `added` is true when the PR introduces the declaration: every hunk that
 * names it adds it, so it is not on the PR's base tree.
 */
export function changedDerivations(files) {
  const seen = [];
  for (const file of files ?? []) {
    const name = file.filename ?? "";
    if (
      !DERIVATION_FILE.test(name) ||
      TEST_TREE.test(name) ||
      file.status === "removed" ||
      !file.patch
    )
      continue;
    const lines = file.patch.split("\n");
    lines.forEach((line, i) => {
      const changed = /^[+-]/.test(line);
      const symbol = changed
        ? declared(line.slice(1))
        : declared(HUNK_CONTEXT.exec(line)?.[1] ?? "");
      if (symbol)
        seen.push({
          file: name,
          symbol,
          sign: changed ? line[0] : " ",
          text: changed ? declarationText(lines, i) : null,
        });
    });
  }
  const bySide = new Map();
  for (const entry of seen)
    if (entry.sign !== " ") {
      const key = `${entry.symbol}\0${entry.text}`;
      if (!bySide.has(key)) bySide.set(key, { "+": [], "-": [] });
      bySide.get(key)[entry.sign].push(entry);
    }
  const moved = new Set();
  for (const sides of bySide.values())
    for (const removed of sides["-"])
      for (const added of sides["+"])
        if (removed.file !== added.file) moved.add(removed).add(added);
  const out = new Map();
  for (const { file, symbol, sign } of seen.filter((e) => !moved.has(e))) {
    const key = `${file}#${symbol}`;
    const prior = out.get(key);
    out.set(key, {
      file,
      symbol,
      added: (prior?.added ?? true) && sign === "+",
    });
  }
  return [...out.keys()].sort().map((key) => out.get(key));
}

const TABLE_HEADER = /consumers?|reaches|surface|terminal/i;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Does the body carry a consumer table (or a heading that announces one)? */
export function hasConsumerTable(body) {
  const { asserting } = speechLines(body);
  for (let i = 0; i < asserting.length; i++) {
    const line = asserting[i];
    if (/^\s*#{1,6}\s/.test(line) && /consumer/i.test(line)) return true;
    if (
      /^\s*\|/.test(line) &&
      TABLE_HEADER.test(line) &&
      TABLE_SEPARATOR.test(asserting[i + 1] ?? "")
    )
      return true;
  }
  return false;
}

/** Is this repo-relative path named in the body, by itself or by a ≥2-segment suffix? */
const namedIn = (body, file) => {
  const parts = file.split("/");
  for (let i = 0; i <= parts.length - 2; i++)
    if (body.includes(parts.slice(i).join("/"))) return true;
  return false;
};

// The first line of the child's complaint, cut so a walker listing every
// declaration a file has ("it has: a, b, c, …") stays one readable row.
const firstLine = (error) => {
  const line =
    String(error?.message ?? error)
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "no reason given";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
};

/**
 * The reach rows for one PR — every one a NOTE, never a failure.
 *
 * @param {object} input
 * @param {{filename: string, status?: string, patch?: string}[]} input.files
 * @param {string|null|undefined} input.body the PR body
 * @param {(file: string, symbol: string) => {terminals: string[]}} input.reachFn
 *   `scripts/reach.ts --json` or a stand-in; `terminals` are the CLI's
 *   `"<kind> <file> <name>"` strings. It may throw; the throw becomes a row.
 * @param {string} [input.walkedOn] the sha of the tree `reachFn` walks; a
 *   decline names it, and says so when the PR itself adds the symbol, which
 *   is then absent from any tree but the PR head or merge tree (#5710).
 * @param {(file: string, symbol: string) => {terminals: string[]}} [input.retryFn]
 *   the SECOND chance, on the PR head itself — called only for a symbol
 *   `reachFn` declined, and only when the caller knows the walked tree is not
 *   the head (#5710). It may throw, including to report that the head could
 *   not be fetched at all; the throw becomes the row's second clause and the
 *   row stays a decline. Omitted, this is exactly #5743's behaviour.
 * @param {string} [input.retryOn] the sha `retryFn` walks — the PR head
 * @returns {string[]} messages, without the `NOTE: ` prefix, in a stable order
 */
export function reachVerdict({
  files,
  body,
  reachFn,
  walkedOn,
  retryFn,
  retryOn,
}) {
  const text = String(body ?? "");
  const candidates = changedDerivations(files);
  const walked = candidates.slice(0, REACH_CAP);
  const rows = [];
  if (candidates.length > REACH_CAP)
    rows.push(
      `reach — ${candidates.length} changed exported lib/ functions in this ` +
        `diff; only the first ${REACH_CAP} (sorted by path) were walked`
    );
  const table = hasConsumerTable(text);
  const tree = walkedOn ? ` (walked on ${shortSha(walkedOn)})` : "";
  const onHead = retryOn
    ? ` on the PR head ${shortSha(retryOn)}`
    : " on the PR head";
  for (const { file, symbol, added } of walked) {
    const terminalsFrom = (walk) =>
      [...new Set(walk(file, symbol).terminals ?? [])].sort();
    let terminals;
    // The tree in hand first, ALWAYS — it is free, it is what CI walks, and a
    // symbol that resolves there needs nothing fetched. Only its decline pays
    // for the head.
    let answeredOnHead = false;
    try {
      terminals = terminalsFrom(reachFn);
    } catch (error) {
      if (!retryFn) {
        rows.push(
          `reach — could not answer for ${symbol}${tree}: ${firstLine(error)}` +
            (added
              ? `; ${symbol} is added by this PR and is not on the walked tree; ` +
                "resolve on the PR head or merge tree"
              : "")
        );
        continue;
      }
      try {
        terminals = terminalsFrom(retryFn);
        answeredOnHead = true;
      } catch (retryError) {
        // BOTH trees named, both reasons quoted. The second reason is where a
        // failed fetch shows up, so this row is what stands between a broken
        // fetch and a row that says nothing.
        //
        // ONE REASON WHEN IT IS ONE REASON. A walker that fails for something
        // other than the tree — no tsx, a child that dies, `scripts/reach.ts`
        // truncating its own JSON on a large walk (measured on #5801's
        // `lib/date.ts#hhmmToMinutes`, 146,176 bytes on BOTH trees) — fails
        // identically twice, and printing the same sentence twice reads as two
        // findings. Same reason, one clause, both trees still named.
        const why = firstLine(error);
        const retryWhy = firstLine(retryError);
        rows.push(
          why === retryWhy
            ? `reach — could not answer for ${symbol}${tree} or${onHead}: ${why}`
            : `reach — could not answer for ${symbol}${tree}: ${why}; nor${onHead}: ${retryWhy}`
        );
        continue;
      }
    }
    if (!terminals.length) continue;
    const terminalFiles = [
      ...new Set(terminals.map((t) => t.split(" ")[1] ?? t)),
    ].sort();
    // An answer row names no tree when it walked the one in hand — that is
    // #5709's shape and every reader knows it. It MUST name one when it walked
    // somewhere else, or the reader cannot tell the two apart.
    const head =
      `reach — ${symbol} (${file}) reaches ${terminals.length} terminal(s)` +
      (answeredOnHead ? onHead : "");
    if (!table) {
      const shown = terminalFiles.slice(0, 8);
      rows.push(
        `${head}; no consumer table in the body (advisory): ${shown.join(", ")}` +
          (terminalFiles.length > shown.length
            ? `, +${terminalFiles.length - shown.length} more`
            : "")
      );
      continue;
    }
    const missing = terminalFiles.filter((f) => !namedIn(text, f));
    rows.push(
      missing.length
        ? `${head}; ${missing.length} not named in the body's consumer table: ${missing.join(", ")}`
        : `${head}; all named in the body's consumer table`
    );
  }
  return rows;
}

// ── THE TALLY LINE (#5710) ───────────────────────────────────────────────────
//
// #5710 promotes the reach row from NOTE to FAIL once it has run on ten PRs
// with no false positive, counted from one-line tallies a landing session
// posts on the issue. In the 43 merges after the count was declared to start,
// 27 fed the walker 198 symbols and NOT ONE tally was recorded: the step asked
// a person to notice an advisory NOTE and then post on a different issue at
// the moment they were about to merge, and nothing failed when they didn't.
// So the gate writes the line and the landing session pastes it; the one
// genuinely human part — WAS THE ROW RIGHT — is the blank at the end.
//
// IT MUST STAY RARE, or it is the NOTE's own failure again: a line printed on
// every merge is noise, and noise is ignored. It is emitted only for a row
// that NAMES A SYMBOL, which is what the tally records and what a person can
// answer right or wrong about. The cap row ("only the first 20 were walked")
// names none and claims nothing about what anything reaches, so it is not
// counted and never produces a line by itself.

const TALLY_DETAILS = 4;

/** One row's entry in the tally line, or null when the row names no symbol. */
const tallyDetail = (row) => {
  const declined = /^reach — could not answer for (\S+)/.exec(row);
  if (declined)
    return { answer: false, text: `${declined[1]} → could not answer` };
  const answered = /^reach — (\S+) \((\S+)\) reaches (\d+) terminal\(s\)/.exec(
    row
  );
  if (!answered) return null;
  const [, symbol, file, terminals] = answered;
  const missing = /(\d+) not named in the body's consumer table/.exec(row);
  const named = missing
    ? `${missing[1]} not named`
    : row.includes("all named in the body's consumer table")
      ? "all named"
      : "no consumer table";
  return {
    answer: true,
    text: `${file}#${symbol} → ${terminals} terminal(s), ${named}`,
  };
};

/**
 * The ready-to-paste tally line for #5710, or `null` when nothing to tally.
 *
 * @param {object} input
 * @param {string|number} input.prNumber
 * @param {string[]} input.rows `reachVerdict`'s rows, exactly as printed
 * @returns {string|null} one line, no newline, or null
 */
export function tallyLine({ prNumber, rows }) {
  const details = (rows ?? []).map(tallyDetail).filter(Boolean);
  if (!details.length) return null;
  const declines = details.filter((d) => !d.answer).length;
  const shown = details.slice(0, TALLY_DETAILS);
  const more = details.length - shown.length;
  return (
    `TALLY #5710 — PR #${prNumber}: ${details.length} reach row(s)` +
    // The split only when it changes the reading: the bar counts CLEAN rows,
    // and a truncated line would otherwise hide that some of these declined.
    (declines
      ? ` (${details.length - declines} answer(s), ${declines} decline(s))`
      : "") +
    `; ${shown.map((d) => d.text).join("; ")}` +
    (more ? `; +${more} more` : "") +
    " — right/wrong?"
  );
}

// ── WALKING THE PR HEAD WHEN THE TREE IN HAND IS NOT IT (#5710) ──────────────
//
// The reach row above walks whatever tree the gate runs in, because
// `scripts/reach-graph.ts` resolves its ROOT from its own module URL: the tree
// that HOLDS the walker is the tree that gets walked. Under the CI wrapper's
// `pull_request` checkout that tree is the merge commit and every symbol
// resolves. Run interactively from a `main` checkout, a declaration the PR ADDS
// is on no tree here, and #5743's decline — honest as far as it goes — is the
// whole answer the reader gets.
//
// This is the other half: fetch the head into a throwaway tree under the state
// dir and walk THERE. Three rules govern it, and they matter more than the
// feature does.
//
//   1. A FAILED WALK STAYS A DECLINE. Nothing here can turn a row green. A
//      fetch that fails, a head that moved, a full disk — each answers
//      `{ok: false, reason}`, that reason becomes the row's second clause, and
//      the row still says "could not answer". The one thing this must never do
//      is fall back to the stale tree and print ITS answer as the PR's: an
//      answer row names no tree, so a silent fallback would read as a clean
//      row for a walk of the wrong commit. Hence no fallback path exists.
//   2. NEVER THE CALLER'S CHECKOUT. `git worktree add` registers metadata in
//      it and `git fetch` writes objects into it; both are writes to a tree
//      this script does not own — the orchestrator's checkout, or a sibling
//      lane's. The temporary tree is a fresh `git init` under the state dir
//      with a shallow fetch straight from origin's URL, so all that is
//      borrowed from the checkout is a read of that URL and a SYMLINK to its
//      node_modules, without which the walker's own tsx cannot start.
//   3. CLEANED UP ON EVERY PATH: on success, on each failure branch here, from
//      the caller's `finally`, and from an exit/SIGINT/SIGTERM handler for the
//      interrupt. What none of those survives is SIGKILL — the normal way a
//      run ends on this box (`lib/__tests__/tmp-dir.ts` carries the census) —
//      so creation also SWEEPS trees older than an hour, which is the same
//      by-construction reclaim that substrate settled on.

/** Directories this module makes under the state dir, swept by whole prefix. */
export const WALK_DIR_PREFIX = "reach-head-";
/** How old an abandoned walk tree must be before a later run unlinks it. */
export const WALK_DIR_STALE_MS = 60 * 60 * 1000;
// A shallow fetch of this repo measured 3.1 s from GitHub and 1.2 s from a
// local path (2026-09-10, `git fetch --depth=1 refs/pull/5795/head`). Five
// minutes is ~100x that, and it is a ceiling on a HUNG transfer rather than a
// budget: the alternative to a timeout here is an advisory row that never
// returns.
const WALK_FETCH_TIMEOUT_MS = 300_000;

/**
 * A `git` runner: `(args, {cwd, timeout}) => {status, stdout, stderr}`.
 * `status` is null when git never ran or was killed. Injectable so a test can
 * drive the failure branches that a real git will not produce on demand.
 * @typedef {(args: string[], opts?: {cwd?: string, timeout?: number}) => {status: number|null, stdout: string, stderr: string}} GitRunner
 */

/** @type {GitRunner} */
const defaultGit = (args, { cwd, timeout } = {}) => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeout ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
    // A private or moved remote must FAIL, never sit on a credential prompt:
    // this runs inside an advisory row that the reader is waiting on.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.error ? String(run.error.message) : (run.stderr ?? ""),
  };
};

// A remote URL can carry credentials (`https://x-access-token:ghp_…@github.com/…`)
// and git ECHOES THE URL in most of its transport errors, so every string that
// reaches a printed row goes through this first. The gate's own rule — never
// print the thrown command or its stdio, because it can hold the Authorization
// header — is the same rule one layer down.
//
// The `{2}` is not decoration: `lib/__tests__/strip-comments.test.ts` censuses
// the tree for the retired line-comment stripper, whose literal shape is a
// slash, two escaped slashes and a negated class — which is character for
// character what the natural spelling of "userinfo before the host" would be
// here. This matches the same two slashes and is not a comment stripper.
const redactUrls = (text) =>
  String(text ?? "").replace(/\/{2}[^/@\s]*@/g, "//<redacted>@");

const firstStderrLine = (text) => {
  const line =
    redactUrls(text)
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "no reason given";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
};

/** `owner/name` from a git remote URL, or null — for `https://…`, `git@…:…` and paths. */
export const repoOfRemote = (url) => {
  const m = /(?:[/:])([^/:]+)\/([^/]+?)(?:\.git)?\/*$/.exec(
    String(url ?? "").trim()
  );
  return m ? `${m[1]}/${m[2]}` : null;
};

/**
 * Does the tree at `repoRoot` already contain `head`, so that walking it walks
 * the PR? Answers `{contained, walkedOn, how}`; `walkedOn` is the checkout's
 * own HEAD, or null when git cannot say.
 *
 * THREE TESTS, AND THE MIDDLE ONE IS THE CI PATH. `actions/checkout@v7` fetches
 * `refs/pull/N/merge` at depth 1, and in that repo the head commit is NOT an
 * object: measured 2026-09-10 on a synthetic replica of that fetch,
 * `cat-file -e <head>` says absent, `rev-parse HEAD^2` fails and
 * `merge-base --is-ancestor` exits 128 — while `cat-file -p HEAD` still lists
 * both parent SHAs, because shallow grafting hides parents from the revision
 * walk and not from the raw object. So the parent-line read is what keeps CI on
 * the in-place walk it has always done; an ancestry test alone would send every
 * CI run to the network.
 */
export function containsHead({ repoRoot, head, git = defaultGit }) {
  const at = git(["rev-parse", "HEAD"], { cwd: repoRoot });
  const walkedOn = at.status === 0 ? at.stdout.trim() : null;
  const no = (how) => ({ contained: false, walkedOn, how });
  if (!walkedOn) return no("this checkout has no resolvable HEAD");
  if (!/^[0-9a-f]{7,40}$/i.test(String(head ?? "")))
    return no("the PR head is not a SHA");
  if (walkedOn === head)
    return { contained: true, walkedOn, how: "this checkout IS the PR head" };
  const raw = git(["cat-file", "-p", "HEAD"], { cwd: repoRoot });
  const parents =
    raw.status === 0
      ? raw.stdout
          .split("\n")
          .filter((l) => l.startsWith("parent "))
          .map((l) => l.slice(7).trim())
      : [];
  if (parents.includes(head))
    return {
      contained: true,
      walkedOn,
      how: "this checkout is a merge commit whose parent is the PR head",
    };
  const ancestor = git(["merge-base", "--is-ancestor", head, "HEAD"], {
    cwd: repoRoot,
  });
  if (ancestor.status === 0)
    return {
      contained: true,
      walkedOn,
      how: "the PR head is an ancestor of this checkout",
    };
  return no(`this checkout is on ${shortSha(walkedOn)}, not the PR head`);
}

/**
 * Unlink the walk trees under `stateDir` older than `staleAfterMs` — the
 * reclaim for a run that was killed before its own cleanup could run. Returns
 * how many it removed. Whole-prefix and one level deep, deliberately: the
 * state dir also holds live lane worktrees and the dispatch ledger.
 */
export function sweepStaleWalkTrees(
  stateDir,
  now = Date.now(),
  staleAfterMs = WALK_DIR_STALE_MS,
  io = fs
) {
  let names;
  try {
    names = io.readdirSync(stateDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(WALK_DIR_PREFIX)) continue;
    const full = path.join(stateDir, name);
    try {
      if (now - io.lstatSync(full).mtimeMs < staleAfterMs) continue;
      io.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // A sibling lane's sweep got there first, or it is not ours to remove.
      // Neither is worth failing an advisory row over.
    }
  }
  return removed;
}

/**
 * Fetch `head` into a throwaway tree under `stateDir` and answer where to walk.
 *
 * @param {object} input
 * @param {string} input.repoRoot   the checkout to read origin's URL and node_modules from — never written to
 * @param {string} input.head       the PR head SHA, which the tree must end up ON
 * @param {string} input.stateDir   $SCRATCH / host.mjs's state dir; the tree lives directly under it
 * @param {string[]} [input.refs]   refspecs to try in order (`refs/pull/N/head` first)
 * @param {string} [input.expectRepo] `owner/name` the checkout's origin must match
 * @param {GitRunner} [input.git]
 * @param {typeof import("node:fs")} [input.io]
 * @returns {{ok: true, dir: string, cleanup: () => void} | {ok: false, reason: string}}
 *   `reason` is one line, credential-free, and is written to be readable as the
 *   second clause of a "could not answer" row.
 */
export function prepareHeadTree({
  repoRoot,
  head,
  stateDir,
  refs,
  expectRepo,
  git = defaultGit,
  io = fs,
}) {
  const short = shortSha(head);
  if (!/^[0-9a-f]{7,40}$/i.test(String(head ?? "")))
    return { ok: false, reason: `the PR head ${short} is not a SHA` };
  if (!stateDir)
    return {
      ok: false,
      reason: "there is no state dir to put a temporary worktree in",
    };
  const remote = git(["remote", "get-url", "origin"], { cwd: repoRoot });
  const url = remote.status === 0 ? remote.stdout.trim() : "";
  if (!url)
    return {
      ok: false,
      reason: `this checkout has no origin remote to fetch ${short} from (${firstStderrLine(remote.stderr)})`,
    };
  // A `--repo other/name` run against THIS checkout's origin would fetch some
  // other repository's PR N and walk it as if it were this one. Refuse instead.
  if (expectRepo && repoOfRemote(url) !== expectRepo)
    return {
      ok: false,
      reason:
        `this checkout's origin is ${repoOfRemote(url) ?? "unreadable"}, not ` +
        `${expectRepo} — refusing to fetch ${short} from the wrong repository`,
    };

  sweepStaleWalkTrees(stateDir);
  let dir;
  try {
    io.mkdirSync(stateDir, { recursive: true });
    dir = io.mkdtempSync(path.join(stateDir, WALK_DIR_PREFIX));
  } catch (error) {
    return {
      ok: false,
      reason: `could not make a temporary worktree under ${stateDir}: ${firstStderrLine(error?.message ?? error)}`,
    };
  }
  // From here every exit runs through this, so no branch below can strand it.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      io.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The sweep at the next creation reclaims what a failed unlink leaves.
    }
  };
  const give = (reason) => {
    cleanup();
    return { ok: false, reason };
  };

  const init = git(["init", "-q"], { cwd: dir });
  if (init.status !== 0)
    return give(
      `could not init a temporary worktree in ${dir}: ${firstStderrLine(init.stderr)}`
    );

  const wanted = refs?.length ? refs : [head];
  let lastError = "no refspec was tried";
  let fetched = false;
  for (const ref of wanted) {
    const run = git(["fetch", "--depth=1", "--no-tags", "--quiet", url, ref], {
      cwd: dir,
      timeout: WALK_FETCH_TIMEOUT_MS,
    });
    if (run.status === 0) {
      fetched = true;
      break;
    }
    lastError = firstStderrLine(run.stderr);
  }
  if (!fetched)
    return give(
      `could not fetch the PR head ${short} from ${redactUrls(url)}: ${lastError}`
    );

  // The SHA, not FETCH_HEAD: a head that moved between the API read and this
  // fetch must be a decline, not a walk of a commit nobody asked about.
  const checkout = git(["checkout", "-q", "--detach", head], { cwd: dir });
  if (checkout.status !== 0)
    return give(
      `fetched, but ${short} is not in what came back — the head may have ` +
        `moved since this gate read it (${firstStderrLine(checkout.stderr)})`
    );

  // The walker runs `npx tsx` in this tree, and tsx and typescript-api resolve
  // from the tree the script sits in. A symlink, so `rmSync` unlinks the link
  // and never walks into the real node_modules.
  const modules = path.join(repoRoot, "node_modules");
  if (io.existsSync(modules)) {
    try {
      io.symlinkSync(modules, path.join(dir, "node_modules"), "dir");
    } catch (error) {
      return give(
        `could not link node_modules into the temporary worktree: ${firstStderrLine(error?.message ?? error)}`
      );
    }
  }
  return { ok: true, dir, cleanup };
}

/**
 * Run `cleanup` when the process ends, however it ends — a normal exit, an
 * explicit `process.exit` (which every one of the gate's verdicts is), or an
 * interrupt. Returns an unregister function for the ordinary path, so the
 * listeners do not outlive the walk.
 *
 * SIGINT/SIGTERM are handled rather than left to default because the default
 * IS termination: no `exit` event fires, and the tree would survive as garbage.
 * Cleaning up and then exiting with the conventional 128+signal keeps the shell
 * seeing an interrupted run.
 *
 * @param {() => void} cleanup
 * @param {{
 *   on: (event: string, handler: () => void) => unknown,
 *   removeListener: (event: string, handler: () => void) => unknown,
 *   exit: (code: number) => unknown,
 * }} [proc] the process — structural, so a test can drive the signal paths
 * @returns {() => void} unregister
 */
export function cleanupOnExit(cleanup, proc = process) {
  const onExit = () => cleanup();
  const onSignal = (signal) => () => {
    cleanup();
    proc.exit(signal === "SIGINT" ? 130 : 143);
  };
  const handlers = [
    ["exit", onExit],
    ["SIGINT", onSignal("SIGINT")],
    ["SIGTERM", onSignal("SIGTERM")],
  ];
  for (const [event, handler] of handlers) proc.on(event, handler);
  return () => {
    for (const [event, handler] of handlers)
      proc.removeListener(event, handler);
  };
}
