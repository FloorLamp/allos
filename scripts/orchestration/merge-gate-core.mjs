// Pure verdicts for merge-gate.mjs. The CLI owns GitHub reads and process exits;
// this module owns decisions so their full matrix does not need a fresh process.

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

export function receiptVerdict(pr, reviews, head = pr.head.sha) {
  const statesHead = (body) =>
    [...(body ?? "").matchAll(/[0-9a-f]{8,40}/g)].some((match) =>
      head.startsWith(match[0])
    );
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
  return {
    ok: false,
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
const reachedAVerdict = (run) => run.conclusion !== "cancelled";

export function checkRunsVerdict(allRuns, ignoreCheck, head) {
  const named = allRuns.filter((run) => run.name !== ignoreCheck);
  const checkRuns = named.filter(reachedAVerdict);
  const pending = checkRuns.filter((run) => run.status !== "completed");
  const red = checkRuns.filter(
    (run) =>
      run.status === "completed" &&
      !["success", "neutral", "skipped"].includes(run.conclusion)
  );
  const ignored = Boolean(ignoreCheck && named.length !== allRuns.length);
  // A name whose EVERY run was cancelled has no verdict at all — not green, and
  // not red either, because nothing failed. Incomplete is the honest state, and
  // the wrapper publishes it as `pending`, which asks for a re-run instead of
  // sending someone to hunt a failure that never happened.
  const decided = new Set(checkRuns.map((run) => run.name));
  const noVerdict = [...new Set(named.map((run) => run.name))].filter(
    (name) => !decided.has(name)
  );
  if (checkRuns.length === 0 || pending.length || noVerdict.length) {
    return {
      kind: "incomplete",
      ignored,
      message:
        `CI INCOMPLETE on ${head.slice(0, 8)}: ${checkRuns.length} registered, ` +
        `${pending.length} pending` +
        (noVerdict.length
          ? `, no verdict for ${noVerdict.join(", ")} (every run cancelled — re-run it)`
          : "") +
        ". Not a verdict — run ci-watch.mjs to settlement.",
    };
  }
  if (red.length) {
    return {
      kind: "fail",
      ignored,
      message: `red checks on this head: ${red.map((run) => run.name).join(", ")}`,
    };
  }
  return {
    kind: "pass",
    ignored,
    message: `all ${checkRuns.length} checks green on this head`,
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
