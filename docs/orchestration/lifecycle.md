# Cadence and lifecycle

- Arm the durable one-shot check-in first on every wake, with the documented
  background fallback. Record the next fire time for the check-in script.
- Post a status pulse every check-in: in flight, merged, queued, and parked or
  awaiting owner.
- Sweep open issues about every four hours for filings, labels, and comment
  rulings.
- Run one adversarial audit over the previous day of merges per session-day.
  File findings against the introducing PR.
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
  same day. Put narrative and receipts in `docs/orchestration-incidents.md`.

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
