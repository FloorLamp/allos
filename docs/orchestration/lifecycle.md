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
- Post a status pulse every check-in: in flight, merged, queued, and parked or
  awaiting owner.
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

## Wind-down

- Stop dispatching new work, land or clearly bank in-flight work, clean
  worktrees and stale branches, stop check-ins, and hand off remaining state.
- Use an unverified WIP marker only when an agent actually died.
- Before deleting dirty work, verify whether the content already landed on main
  in another form.

## Out of scope

- Strategic or architectural work without owner approval.
- Owner judgment about information architecture, navigation, or tone.
- Documentation is not fenced: agents keep relevant documentation current, but
  do not restructure top-level guidance incidentally.
