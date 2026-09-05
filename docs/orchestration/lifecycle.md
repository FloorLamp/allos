# Cadence and lifecycle

- Arm the durable one-shot check-in first on every wake, with the documented
  background fallback. Record the next fire time for the check-in script.
- Owner HOLDS live in `$SCRATCH/.holds`, never in the orchestrator's head: one
  per line as `<scope> :: <release condition> :: <what it gates>`. The check-in
  prints them; test every release condition on every wake.
- A hold is the only input no script can derive, so its loss to a restart is the
  silent one. Everything else the recorder prints is recoverable.
- The wake prompt carries only DURABLE facts — holds, owner-gated items,
  standing constraints — and points at the tooling for current state. A wake
  that enumerates PR numbers and their status is stale before it fires: three
  in a row named work already merged (2026-08-16).
- The check-in script and `dispatch-brief.mjs list` are ground truth on wake.
  Read them before acting on anything the prompt asserts, including your own.
- Sweep open issues about every four hours for filings, labels, and comment
  rulings.
- Run one adversarial audit over the previous day of merges per session-day.
  File findings against the introducing PR.
- After each UI-affecting merge, while its PR context is fresh, run
  `UX_SEED=1 node scripts/orchestration/post-merge-census.mjs HEAD^ HEAD --run`.
  It scopes app territories, expands shared UI to a full census, and stops when
  the mapping needs a manual plan.
- Dispatch continuously until every remaining issue is blocked, owner-gated, or
  dependency-bound; state that explicitly.
- Keep `parked` labels and status reports consistent.
- Merge Dependabot minors on green current main. Send majors through
  `dependabot-eval-brief.mjs` within a day.
- Give infrastructure issues priorities; active bottlenecks are P1 and isolated
  latent flakes are P3.
- Never edit a live agent's worktree without messaging it and receiving an
  acknowledgement.
- Rerun failed Actions jobs only after all jobs in the run have completed.
- A failed job whose steps are all green is infrastructure; inspect the steps,
  then rerun.
- Institutionalize lessons in tooling or the relevant focused runbook file the
  same day — those are the only durable homes. Narrative that fits neither is
  cut, not relocated; history lives in git.

## Status pulse

- The pulse is the census line plus EXCEPTIONS only: a red `main`, a
  blocker, a needs-human filed, a merge. Nobody reads the transcript — no
  narration between tool calls, no plans, no recaps. Findings go to their
  durable homes (PR reviews, issue comments, the ledger); the PM by SendMessage.
- Its data half is the check-in's own recorder output. The catch-up digest
  (`pm-digest.sh`) is the PM's, written for the owner, not an orchestrator's pulse.
- The pulse OPENS with one census line in a fixed grammar, and the turn's
  status detail carries the same line, so a PM reads saturation without
  inference: `e2e 2/2 · ord 3/5 · slot #4764 green · banked 2 · blocked #4218`.
- Read the Ladder issue (#4769, `parked` + `docs`) at every check-in: rung
  order, your slice, prerequisites. It outranks your own ranking; a
  disagreement goes to the PM, not into the queue.

## Wind-down

- Stop dispatching new work, land or clearly bank in-flight work, clean
  worktrees and stale branches, stop check-ins, and hand off remaining state.
- Use an unverified WIP marker only when an agent actually died.
- Before deleting a branch or dirty work, settle it on CONTENT: compare its
  files against `main` and say which comparison answered. The PR record and
  the surviving ref are hints; `main` is the verdict.
- `merged=false` is not evidence nothing landed — work re-lands under a new PR
  from a renamed successor branch (#5220), and a squash can leave the record
  unmerged (`recovery.md` §A merge that half-landed).
- Nor is a non-empty `git diff $(git merge-base main <branch>) <branch>`
  evidence of unlanded work: one of #5220's 48 branches was byte-identical to
  `main`, a sibling PR having carried the same hunk. A merge-base diff cannot
  see that; only `git diff main <branch> -- <file>` can.

## Out of scope

- Strategic or architectural work without owner approval.
- Owner judgment about information architecture, navigation, or tone.
- Documentation is not fenced: agents keep relevant documentation current, but
  do not restructure top-level guidance incidentally.
