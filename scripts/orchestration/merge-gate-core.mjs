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
// Rows, not a verdict, because the three callers ask three questions of one
// classification — the gate asks "may this merge", the watcher asks "has
// registration stopped moving", the board asks for a line per PR.
//
// `state` is the whole vocabulary and each value is a different action:
// `pending` waits, `failed` stops, `success` passes; a name whose every run
// was CANCELLED reaches no state at all and comes back in `noVerdict`, which
// asks for a re-run rather than sending anyone to hunt a failure that never
// happened. Statuses cannot be cancelled and have four states, of which
// `error` and `failure` are both a red.
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
// `merge-gate` is the only commit status this repo posts, and
// .github/workflows/merge-gate.yml posts it by running THIS script. So a gate
// that counted its own context would be reading back its own last answer: a
// `failure` posted before the receipt landed would close the gate, the
// workflow would re-run the gate, the gate would read the failure it had just
// posted, and post it again — a self-block with no way out, in the one tool
// whose refusal stops every merge. It is excluded here and recomputed instead,
// in full, by every other check in merge-gate.mjs.
//
// EVERY OTHER CONTEXT STILL COUNTS, and that half is the point of the issue: a
// deploy gate, a coverage bot or any future required context is exactly what
// nothing in this script recomputes, so ignoring it is how a merge goes out
// over a red nobody read.
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
// which is why no per-branch check of any kind could have seen it —
// lib/__tests__/type-verdict.test.ts pins that as the combined-tree case.
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
