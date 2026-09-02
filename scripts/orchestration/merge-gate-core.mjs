// Pure verdicts for merge-gate.mjs. The CLI owns GitHub reads and process exits;
// this module owns decisions so their full matrix does not need a fresh process.

const ASSERTS_INDEPENDENCE =
  /\b(?:did not|didn'?t)\s+(?:author|write)\b|\bindependent(?:ly)?\s+review/i;

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
          ASSERTS_INDEPENDENCE.test(review.body ?? "")
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
        "with that statement"
      : staleReceipt
        ? `no receipt for ${head.slice(0, 8)} — the head changed since ` +
          `${staleReceipt.user.login}'s review, which VOIDS it; re-review this head`
        : "no exact-head receipt: no review states this head SHA",
  };
}

// One head, one verdict per check NAME (#4800). GitHub returns the latest run
// per name PER CHECK SUITE, so a push that races the previous run's start
// leaves TWO runs under one name: the one the workflow's `concurrency` group
// cancelled, beside the one that replaced it. Counting both reads the cancelled
// one as red on a head the checks tab shows green — and it fails toward
// blocking a landing. The newest run supersedes the earlier ones; ids are
// assigned in creation order, which `started_at` is the readable form of.
function currentRuns(runs) {
  const newest = new Map();
  for (const run of runs) {
    const held = newest.get(run.name);
    if (!held || run.id > held.id) newest.set(run.name, run);
  }
  return [...newest.values()];
}

export function checkRunsVerdict(allRuns, ignoreCheck, head) {
  const named = allRuns.filter((run) => run.name !== ignoreCheck);
  const checkRuns = currentRuns(named);
  const pending = checkRuns.filter((run) => run.status !== "completed");
  const red = checkRuns.filter(
    (run) =>
      run.status === "completed" &&
      !["success", "neutral", "skipped"].includes(run.conclusion)
  );
  const ignored = Boolean(ignoreCheck && named.length !== allRuns.length);
  if (checkRuns.length === 0 || pending.length) {
    return {
      kind: "incomplete",
      ignored,
      message:
        `CI INCOMPLETE on ${head.slice(0, 8)}: ${checkRuns.length} registered, ` +
        `${pending.length} pending. Not a verdict — run ci-watch.mjs to settlement.`,
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
  const shards = currentRuns(
    runs.filter((run) => run.name.startsWith(detector))
  );
  if (!shards.length)
    return `${detector}: no verdict on ${at} — it debounces, and skips a push with no runtime surface`;
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
  return `${detector}: ${at} is green (${shards.length} shards)`;
}
