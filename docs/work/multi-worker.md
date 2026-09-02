# Two workers on one repo

Each worker runs in its own container: its own roster, ledger, machine
cap and E2E cap. What they share is GitHub — issues, branches, PRs, `main`.

## The slice

- The PM assigns each worker a SLICE by domain in the Ladder issue
  (#4769, labels `parked` + `docs`). Dispatch only inside your slice; an
  issue outside it is not yours even when it is ready and small.
- Slices are disjoint by FILES as much as by labels. The Ladder names the
  paths a slice never edits; needing one is a message to the other
  worker (SendMessage to its session id), answered in writing, PM
  copied.

## Claim before dispatch

- Before `dispatch-brief.mjs new`: `git ls-remote --heads origin` — an issue
  number already in a branch name is claimed; and read the issue's comments —
  a `Dispatched:` note from any worker is a claim.
- On dispatch, post one comment per clustered issue over REST
  (`environment.md` §GitHub access) and re-read to verify:
  `Dispatched: lane \`<branch>\` (worker <A|B>, <UTC>)`.
- The note is durable where the roster is not: it survives the container.
  Never remove it; closing the issue supersedes it.

## File fence across sessions

- `claims <path>` knows only your own lanes. For every path a brief will
  touch, also run `git diff --name-only origin/main...origin/<branch>` over
  the other worker's live branches. Overlap is sequencing, not a race:
  bank, or take the next issue.

## One landing slot, repo-wide

- At most ONE open ready non-dependabot PR at a time. Before promoting a
  candidate, list open PRs; if the other worker's is open, bank and
  re-check when it merges. The slot goes to whoever finds it empty.
- After any merge on `main`, both recheck every open PR's mergeability.
- A red `main` is everyone's problem: the merge that turned it red owns the
  next landing; the other worker leaves it alone and tells the PM.
- `e2e-main` is one concurrency group across both sessions; a queued run is
  not a red.

## Bookkeeping

- One worker, named in the Ladder, writes the day's release-notes
  batch; the other sends its user-visible bullets to the PM.
- Report the census line (`lifecycle.md` §Status pulse) to the PM on request
  by SendMessage. The PM arbitrates fence disputes and slot starvation.
