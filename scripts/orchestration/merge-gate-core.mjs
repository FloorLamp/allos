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

const quotedLine = (line) => /^\s*>/.test(line);

/**
 * Does this review body ASSERT that its writer did not author the change?
 *
 * Blockquoted lines are dropped before the test: a receipt that quotes somebody
 * else's independence claim is reporting one, not making one. Hedged sentences
 * are dropped too. `why` names which of those swallowed the only candidate, so
 * the refusal can say "your markdown ate the phrase" rather than leaving the
 * writer to guess — the second cost #5166 records.
 *
 * @param {string} body
 * @returns {{ asserts: boolean, why: null | "quoted" | "hedged" }}
 */
export function independenceClaim(body) {
  const lines = String(body ?? "").split("\n");
  const own = lines.filter((line) => !quotedLine(line)).join("\n");
  if (
    sentences(own).some((s) => ASSERTS_INDEPENDENCE.test(s) && !HEDGED.test(s))
  )
    return { asserts: true, why: null };
  if (sentences(own).some((s) => ASSERTS_INDEPENDENCE.test(s)))
    return { asserts: false, why: "hedged" };
  return {
    asserts: false,
    why: sentences(lines.filter(quotedLine).join("\n")).some((s) =>
      ASSERTS_INDEPENDENCE.test(s)
    )
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
          ? ". The only such sentence here is BLOCKQUOTED — quoting somebody " +
            "else's claim is reporting one, not making one"
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
  const detected = runs.filter((run) => run.name.startsWith(detector));
  const shards = detected.filter(reachedAVerdict);
  if (!shards.length)
    return detected.length
      ? `${detector}: no verdict on ${at} — every shard run was cancelled; re-run it`
      : `${detector}: no verdict on ${at} — it debounces, and skips a push with no runtime surface`;
  const red = shards.filter(
    (run) =>
      run.status === "completed" &&
      !["success", "neutral", "skipped"].includes(run.conclusion)
  );
  if (red.length)
    return `${detector}: ${at} is RED — ${red.map((run) => run.name).join(", ")}. Attribute it before merging onto it (#4722)`;
  const pending = shards.filter((run) => run.status !== "completed");
  if (pending.length)
    return `${detector}: still running on ${at} (${pending.length} of ${shards.length})`;
  // A SKIPPED SHARD IS NOT A GREEN ONE (#4370). e2e-main skips a push with no
  // runtime surface, and this line used to fold `skipped` in with `success` and
  // report "is green (4 shards)" over a run that executed no browser at all —
  // the exact false confidence #4370 was filed about, printed at the moment a
  // merge decision is taken.
  const ran = shards.filter((run) => run.conclusion !== "skipped");
  if (!ran.length)
    return `${detector}: ${at} ran NOTHING (${shards.length} shards skipped — no runtime surface in that push). Not a green; the nightly is what covers main`;
  return `${detector}: ${at} is green (${ran.length} of ${shards.length} shards ran)`;
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
// receipt gets applies here, so an emphasised or blockquote-indented marker
// still reads.
//
// A HOLD IS NOT HEAD-BOUND AND A PASS IS. That asymmetry is the whole point of
// each: a hold that a push could lift is a hold anyone can walk through by
// pushing, and a pass verdict that survived a push would be evidence about code
// that no longer exists — the same void the receipt takes on a head change.

/** Marker lines carried by a note set, newest first. */
function markerLines(notes, name) {
  const opener = new RegExp(`^${name}\\b\\s*:?\\s*`, "i");
  const found = [];
  for (const note of notes ?? []) {
    for (const raw of String(note.body ?? "").split("\n")) {
      const line = unemphasise(raw)
        .replace(/^[>\s]+/, "")
        .trim();
      if (!opener.test(line)) continue;
      found.push({
        line,
        rest: line.replace(opener, "").trim(),
        at: note.at ?? "",
        who: note.user ?? "someone",
      });
    }
  }
  // Newest first, and a HOLD wins a tie: two markers stamped the same second
  // are not ordered by anything, and the conservative reading is the one that
  // does not open a gate on a coin flip.
  return found.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}

/**
 * The general hold (#5126): an orchestrator's machine-readable "not yet", for
 * any stated reason, liftable by the same convention.
 *
 * @param {{ body: string, at?: string, user?: string }[]} notes reviews and PR comments
 */
export function holdVerdict(notes) {
  const marks = markerLines(notes, "MERGE-HOLD");
  if (!marks.length) return { held: false, message: null };
  const newest = marks[0].at;
  const current = marks.filter((m) => m.at === newest);
  const held = current.find((m) => !/^lifted\b/i.test(m.rest));
  if (held) {
    return {
      held: true,
      message:
        `MERGE HOLD in force — ${held.who} wrote "${held.line}" at ` +
        `${held.at || "an unrecorded time"}. A hold outlives a push, by design; ` +
        'lift it with a "MERGE-HOLD LIFTED: <reason>" note when what it names is settled',
    };
  }
  return {
    held: false,
    message: `merge hold LIFTED at ${current[0].at || "an unrecorded time"} — "${current[0].line}"`,
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
  const marks = markerLines(notes, "FALSIFYING-PASS");
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
        `${grounds}. When it reports, ${post}`,
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
        `and ${post}. The void verdict was "${marks[0].line}"`,
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

/** The session id a PR body's footer names, or null. */
export function bodySession(body) {
  return /\bsession_([A-Za-z0-9]+)/.exec(String(body ?? ""))?.[0] ?? null;
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
 * @param {{ body?: string }} pr
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
