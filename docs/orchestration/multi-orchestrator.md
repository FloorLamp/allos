# Orchestrators on one repo

Each orchestrator runs in its own container: its own roster, ledger, machine
cap and E2E cap. What they share is GitHub — issues, branches, PRs, `main`.

## Spawning one

- The PM spawns every orchestrator on **Opus**, naming the model explicitly:
  `create_session` inherits the PM's model otherwise, so a PM running anything
  else silently seeds the fleet with it (owner, 2026-09-06).
- The model is fixed at creation. A running session keeps the model it started
  with until it is REPLACED — a new session, not `archive`/`unarchive`, which
  recycles the container and keeps the model. So a fleet is moved onto Opus one
  replacement at a time, at the moments a session is being replaced anyway.
- Replacing a session discards its context; its durable state is the Ladder,
  the `Dispatched:` notes and the pushed branches, which is what the successor
  reads. Unpushed work is the only thing a replacement loses.

## The slice

- The PM assigns each orchestrator a SLICE by domain in the Ladder issue
  (#4769, labels `parked` + `docs`). Dispatch only inside your slice; an
  issue outside it is not yours even when it is ready and small.
- Slices are disjoint by FILES as much as by labels. The Ladder names the
  paths a slice never edits; needing one is a message to the owning
  orchestrator (SendMessage to its session id), answered in writing, PM
  copied.

## Slots

- The machine cap counts running agents, not branches: a lane that returned
  banked holds no slot (keep its worktree; re-dispatch it against the banked
  head when its ruling lands). A receipt is a review, never a lane, so the cap
  never delays one.

## Claim before dispatch

- Before `dispatch-brief.mjs new`: `git ls-remote --heads origin` — an issue
  number already in a branch name is claimed; and read the issue's comments —
  a `Dispatched:` note from any orchestrator is a claim.
- On dispatch, post one comment per clustered issue over REST
  (`environment.md` §GitHub access) and re-read to verify:
  `Dispatched: lane \`<branch>\` (orchestrator <letter>, <UTC>)`.
- The note is durable where the roster is not: it survives the container.
  Never remove it; closing the issue supersedes it.

## File fence across sessions

- `claims <path>` knows only your own lanes. For every path a brief will
  touch, also run `git diff --name-only origin/main...origin/<branch>` over
  every other orchestrator's live branches. Overlap is sequencing, not a race:
  bank, or take the next issue.

## Merges are serial, PRs are not

- Open a PR for every branch that passed its gates, whichever orchestrator
  owns it; CI and review run in parallel. Only the merge is serial,
  repo-wide: re-read `main`'s head, merge one green exact head, then let the
  other's candidates re-judge with `landing-independence.mjs` (exit 0 = fine).
- A red `main` is everyone's problem: the merge that turned it red owns the
  next landing; the others leave it alone and tell the PM.
- `e2e-main` is one concurrency group across all sessions; a queued run is
  not a red.

## Bookkeeping

- One orchestrator, named in the Ladder, writes the day's release-notes
  batch; the others send their user-visible bullets to the PM.
- Report the census line (`lifecycle.md` §Status pulse) to the PM on request
  by SendMessage. The PM arbitrates fence disputes and slot starvation.
