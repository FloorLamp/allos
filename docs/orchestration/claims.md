# Cross-session markers

Two orchestrator sessions run against this repo and post as one GitHub account,
so every coordination fact here is a MARKER a script reads, not a relayed line.

## Claiming an issue

- Claim by commenting on the issue, naming the branch, BEFORE briefing. The two
  spellings in use, quoted off the tracker:
  - `` Dispatched: B, branch `live-practice-self-complete-5091` `` (#5091)
  - ``Dispatched: branch `dispatch-claim-refusal-5108` (orchestrator A, …)``
    (#5108)
- The BRANCH is the discriminator, never the author: a claim naming the branch
  you are about to create is your own, and any other branch is another lane's.
- Read the issue WHOLE first — `issue-read.mjs <n>`, body and every comment,
  unpiped. #5091 filtered the claim out of a `sed` pipe; #5125 wrote none at
  all. Being first is not the same as having claimed.
- `dispatch-brief.mjs new` refuses a claimed issue, and refuses DISTINCTLY when
  a claim cannot be READ — unreachable is CANNOT TELL, not CLEAR (#5108).
  `--adopt-claim` overrides a claim you have read and judged stale.

## Whose PR is it

- The PR body's `claude.ai/code/session_…` footer, not its author, says whose
  landing slot it is (#5177). No footer is UNKNOWN, never yours: older and
  human-authored PRs carry none.
- `new` and `adopt` refuse a branch that already heads another session's open
  PR, under the same `--adopt-claim`. `merge-gate.mjs` asks again before the
  merge, where the escape is `--adopt-pr`.

## Holding a merge

- `MERGE-HOLD: <reason>` on the PR, as a review or a comment, closes the gate;
  `MERGE-HOLD LIFTED: <reason>` releases it. A hold is NOT head-bound — one a
  push could lift is one anyone can walk through by pushing (#5126).
- Where `adversarial-review-brief.mjs --check` says MANDATORY, `merge-gate.mjs`
  requires the pass's own verdict on the current head, as
  `FALSIFYING-PASS: SURVIVES <sha>` or `FALSIFYING-PASS: FALSIFIED <sha>`.
- A head change VOIDS a pass verdict exactly as it voids a receipt. A label
  cannot: it is not on the head, which is why neither of these is one.
