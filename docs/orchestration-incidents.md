# Orchestration incidents — the receipts

Status: **living** · the incident history behind `docs/orchestration.md`

The runbook states the rules; this file keeps the stories that bought them.
Read a section here when you want to know _why_ a rule exists or exactly what
its failure looked like — never instead of following the rule. Each heading is
a stable anchor the runbook cites.

Session lineage: the first orchestrated session merged 98 PRs and closed ~215
issues with zero reverts; later ones added the migration-slot protocol
(098–108), the #1392/#1417 census root-causes, the release-notes pipeline, the
`parked`/dependabot rulings, the check-in cadence, and the merge-commit
discipline. Every session so far has held zero reverts.

## The canary that couldn't (2026-08-12)

The old restart detector was a `while true; do sleep 3600; done` background
process whose DEATH was supposed to signal a container restart. It cannot work,
by construction: the restart kills the harness that would deliver the death
notification along with the canary — a smoke alarm wired to the same fuse as
the house. One ran for a whole session, died at 14:08, and said nothing. The
same restart killed both check-in timers (`sleep` loops in the same process
tree), so the boot-id comparison that DOES work never ran again. Full chain:
restart → canary dies unheard → timers die → nothing polls → the orchestrator
keeps merging as though nothing happened. A human asking "container died?" is
what surfaced it.

The fix (`scripts/orchestrator-checkin.sh`) detects by STATE: disk-persisted,
pull not push, self-describing. Two follow-on lessons from hardening it:

- **The alarm only works if it is silent when nothing is wrong.** The first
  version flagged every live agent's worktree as `DIRTY: RESCUE` (an agent
  mid-task has uncommitted work by definition) and every merged branch as
  `NO REMOTE BRANCH` (branches are deleted on merge). Three of six rows
  screamed on two consecutive check-ins with nothing wrong — not absent, but
  **ignorable**, which is the canary's failure a second time. The missing
  input was the roster: dirty + live agent = work in progress; dirty + no
  agent = nobody is coming back for it.
- **`merge-base --is-ancestor` cannot answer "was this merged" under squash.**
  The merged commit is a new object with an unrelated parent, so the predicate
  reads perfectly and can only ever answer "no" — the #2444 shape, a guard
  that covers nothing while still looking like one. Used alone it flagged all
  three finished worktrees as unpushed on the very run that fixed the previous
  false alarm. The real signal is whether the branch was ever PUSHED: tracking
  config survives upstream deletion, so upstream-configured + remote-gone is
  merged-and-tidied; no upstream + no remote is work that exists nowhere else.
- The script itself lives in the REPO: the first version was written to
  `$SCRATCH` and would have died in the next restart — the same mistake one
  level up. And after any change that makes a monitor quieter, create a
  worktree that genuinely deserves the alarm, confirm it fires, delete it.
  Untested silence is indistinguishable from a broken detector.

## The three signals read literally (2026-08-10)

Every rule in the runbook's forbidden-signals table already existed in prose
that day, and was walked past anyway — three times in one session, twice within
ten minutes. Cost: ~27 agent-hours and two near-losses of finished work. Prose
in a list did not work, which is why the table exists, and why the rules that
could become scripts since have.

## The stalls, measured (2026-08-10)

Two agents ran **12.9 h** and **13.7 h** against a same-day median of ~55 min
(46/50/57/66). Neither had restarted; both were writing to their transcripts
minutes before the check; neither had a PR.

- **Denied-and-idle (12.9 h).** Its first `git worktree add` and `cp -al` were
  refused by the permission system — transiently; siblings' identical commands
  succeeded — and, correctly not retrying, it just sat. Four tool calls,
  nothing to salvage, no worktree after thirteen hours: visible from minute
  five, if anyone had looked. Hence the brief line "if a tool call is DENIED,
  STOP AND REPORT IMMEDIATELY, quoting what was refused verbatim."
- **Working-and-unbanked (13.7 h).** Fifty files, lint + typecheck + full pure
  tier green, zero commits, nothing pushed, all in a dirty worktree an
  ephemeral container could erase. "COMMIT AND PUSH after every meaningful
  step" had been in the template for months; deep in a large change an agent
  reads that as restart advice, not a hard gate — hence the ~10-files /
  ~45-minutes checkpoint gate.
- **Under-scoping caused the second stall.** The brief said "add a slug to
  `TREND_METRIC_SLUGS`"; the honest implementation dragged fifteen files of
  import plumbing, a real projector, and a migration moving rows already on
  disk. An agent cannot re-scope a task it was told was small — hence the
  say-so-and-checkpoint line.
- **Committed-and-unpushed** is the variant that survives every rewording:
  three separate agents in one session committed reliably and forgot the push,
  because the commit feels like the banking step. The gate is now stated as a
  property of the REMOTE (the branch must exist there at the latest commit)
  because that is what a check-in can verify.
- Separately: one restart killed three live agents holding ~2,300 uncommitted
  lines that existed only under `/tmp`. Rescue trees FIRST, as explicitly
  labelled un-gated WIP commits, before any diagnosis.

## Credential loss — how it hides (three traps)

A restart can wipe `$GH_TOKEN`/`$GITHUB_TOKEN` and the git proxy's push
credentials while everything else keeps working. This cost most of a session,
entirely because of how well it hides:

- **`git fetch` and `git ls-remote` still succeed anonymously** on a public
  repo. "Git still works, agents can still push" was reported in a check-in on
  exactly this evidence, and it was wrong.
- **A bash CI poll silently prints `(none)`** for open PRs — the curl 401s and
  the JSON parse yields nothing, which reads as "no PRs open": a lie in the
  reassuring direction. (`ci-watch.mjs` asserts the token for this reason.)
- **MCP GitHub tools keep their own auth** and go on working, making the
  failure look narrower than it is.

Also learned: pushing branch contents through MCP `push_files` is a last
resort that does not scale — one 407 KB amendment cost ~115k tokens. And an
agent that went hunting for credentials on the filesystem tripped the
permission classifier; the token is used by NAME or not at all.

## The shared-scratchpad clobber

One agent wrote `pr-body.md`; a sibling overwrote it between the write and the
POST, and the PR was opened carrying **another PR's body**. Branch-unique
scratch names are mandated in every brief, and "re-read the PR body back from
the API after posting" is in the template because it is the check that caught
this — load-bearing, not ceremony.

## The worktree inside the checkout

An agent left to choose its own worktree location put it at
`.claude/worktrees/<branch>` — a second copy of the repo, untracked, _inside_
the first, one `git add -A` from being committed into itself. Nothing broke;
`/.claude/worktrees/` is gitignored as a backstop, and the brief naming
`$SCRATCH` is the fix.

## gitleaks — what actually triggers it (#2409)

CI's gitleaks runs over the refs in that job's checkout (its branch + main), so
a finding on one feature branch left every other open PR green — blast radius
is one branch _until it merges_, at which point the blob is in every checkout
and only rewriting published main history removes it. The trigger is an
identifier `generic-api-key` recognizes + an entropy threshold + a word-shape
filter, and **entropy alone does not predict it**: measured on three sibling
values in one file, `omega3-anticoagulant` (3.522) FIRED while
`fish-oil-anticoagulant` (3.573) and `dairy-levothyroxine` (3.722) passed —
all three clear the threshold, but the two that read as plain words are
filtered as prose and the one carrying a DIGIT is not. A JSON field literally
named `key` counts as an identifier. Fix by renaming to a word-shaped value,
never by allowlisting: an allowlist is permanent and a rename costs nothing.

And a red gitleaks is not always a finding (#2592): the job downloads its own
binary, and an unguarded fetch redded the check having scanned nothing — three
unrelated PRs inside eight minutes, in two different curl signatures
(`(22) 503` and `(56) Connection died`, whose "tried 5 times" is curl's
internal connection reuse, not `--retry`). #2592 gave the download
`--retry 5 --retry-all-errors`, pinned the archive by sha256, and made every
install failure emit a `gitleaks did not run` annotation.

## Container load, measured (#2398)

Several worktrees running gates at once pushed `npm run test:db` to ~6× normal
wall time (~200 s → ~1280 s). The first casualties are wall-clock-slack
assertions: `lib/__db_tests__/auth.test.ts` asserts a cookie and DB expiry land
within 1000 ms and measured 1027 ms. The same pressure is the suspected cause
of container restarts — hence the ~4-agent cap and sequential gates.

## Migration-slot incidents

- Two agents both wrote `165-*.ts` because one brief never mentioned slots — a
  prompt silent on slots is not neutral, it delegates the choice.
- A correctly-briefed agent still burned a round building a contingency for a
  slot gap that had already been filled — say what is ON MAIN, not only what
  the agent holds.
- A branch appeared carrying a different `Claude-Session:` trailer and
  claiming 167, the slot the map recorded as free — the ledger is
  authoritative only over dispatches it recorded, so unknown remote `claude/*`
  branches get their trailers read, not assumed.

## CI tests the merge commit — the case studies

- **A widening signature outruns a green run.** `zonedWallTimeToUtc` gaining a
  `null` return (#2245) broke two branches (#2250, #2252) in both directions
  in one afternoon: one green against a base predating the new call sites, the
  other writing fixtures against the old signature while the change landed.
  Both agents reported green honestly; `git merge-tree` and `mergeable_state`
  both said clean while the merged tree failed to typecheck.
- **A count-freezing allowlist goes stale when parallel work merges.** #2205's
  instant-writer scan fired on code its branch had never seen, because CI
  scans the merge commit. That is the ratchet working — reconcile at merge
  time and raise the counts WITH reasons.
- **A behind-only PR's green can be stale** — this broke main for ~1 h.
  #1560's green predated #1562's merge; textually conflict-free, semantically
  incompatible (one added a chart kind, the other had just made a prop
  mandatory for every chart kind), and the squash landed a main red on `tsc`
  and `npm test`.
- **Rebasing across a merged route restructure** (2026-07-22, #1079): a spec's
  `page.goto("/old#anchor")` strings are untyped, so the AppRoute sweep cannot
  flag them — grep rebased specs for stale route literals. The stale-typecheck
  half of that hazard is fixed (#2293: `npm run typecheck` runs `next typegen`
  first).

## Review-caught shapes worth remembering

- **The binary-that-should-be-text (#2547).** A new `.ts` shipped as
  `Bin 0 -> 7407 bytes` because its key separator was three raw NUL bytes. No
  diff, no blame, no line comments — and the PHI/secret gates are TEXT scans,
  so their green over a file they may not have read as text is not the
  reassurance it looks like. The escape sequence is byte-identical at runtime.
- **A claimed count is a measurement with a timestamp (#2528).** The issue said
  274 entries; the agent's own base had 278. At this merge rate, ask for a
  re-count in the brief and check the PR reports one.
- **A curated dataset's diff must show only intended changes (#2544).** Four
  `1.0`→`1` edits in `canonical-biomarkers.json` were the only visible
  evidence of a `JSON.parse`/`stringify` round-trip — a regenerate is
  invisible whenever it preserves key order and loses no precision. (Prettier
  leaves JSON numbers alone; check before believing that story.)
- **Verify a PR's claims about pre-existing bugs (#2537).** "The rename caught
  two real bugs" — both were correct on main and broke only transiently inside
  the branch. A bug a change introduces and then fixes is not a bug it found,
  and a PR body is read back later as fact.

## E2E ownership failures

- #1066 and #1115 both shipped brand-new specs that failed on first push
  because nobody ran them — "only you run e2e" never excused an author from
  its own new spec.
- "Write the spec, do not run it, I will run it" produced red CI both times it
  was briefed: #2562 (8 failures) and #2584 (3/3 on the one new spec). Both
  were spec bugs an author's first local run would have caught in seconds
  (#2584: two taps of one food row share ONE ledger key, so the second is
  absorbed by `POST_SUCCESS_COOLDOWN_MS`; `food-log.spec.ts` already reloads
  between repeated taps for exactly this). The split fails structurally: the
  author is the only party holding the feature's state in mind at the moment
  the spec is written, and the split defers discovery past review and past the
  CI round to a job log.
- The repeat-each lane keeps catching real defects retries would have masked:
  a debounced-autosave orphan row poisoning the next repeat; a live-mode
  finish seam remounting the form.
- A whole night of "container degradation" during a local full suite was a
  background poll loop starving the per-worker servers — nothing else runs
  during a full-suite run.

## Process drift, caught by others (2026-08-06)

Twice in one day the orchestrator drifted from a rule already written in the
runbook — reviews through the GraphQL MCP path instead of the documented REST
one, and dispatch prompts saying `PORT=` where the Local e2e row says
`E2E_PORT=` (which is inert: `playwright.config.ts` reads
`E2E_PORT ?? 3100`, so two agents shared base 3100 and manufactured the flaky
results the orchestrator then spent the day diagnosing). Both were caught by
someone else. This is the standing argument for the tooling section: when the
runbook already answers something, the answer belongs in a script.

## Assorted receipts

- **ScheduleWakeup**: a harness scheduled wakeup silently failed to fire and
  produced a 52-minute dead gap the owner had to notice (2026-08-01) — hence
  `send_later` + a backup sleep timer, never ScheduleWakeup.
- **The restore time-warp**: a container restore reverted the checkout, the
  `origin/main` ref (the git proxy serves a stale mirror) and the task list
  together, reading exactly like "main was force-pushed back N merges". GitHub's
  REST API is the only authoritative view.
- **The three-hour zombie PR**: one PR sat in the CI queue three hours against
  a base that no longer existed AND a conflict; nothing surfaced it because
  only check status was watched — hence the one-`pulls/N`-read-per-open-PR
  rule after every merge.
- **Priority by habit**: #1511 and #1534 both went out as P2 because "infra
  chore" reads as P2; both were bottleneck-class and taxed every subsequent
  unit of work — hence bottlenecks are P1.
- **The superseded draft**: a wind-down nearly deleted a worktree holding ~330
  uncommitted lines that looked like lost work and was a superseded draft
  already on main in a later form. Deleting is irreversible; checking is two
  greps.
- **Audit-first pays**: one audit-first brief closed an issue with zero code
  and halved two builds; without it those agents would have re-implemented
  merged work.
- **The post-merge sweep's proof (#2444)**: a shipped migration's FK-guard was
  silently dead because it named a nonexistent table — caught by a scheduled
  review of the previous 24 h of commits, and by nothing else: not the
  authoring agent, not the pre-merge review, not CI.
- **Why "format LAST" and "re-run e2e-hygiene after any spec edit"**: two
  consecutive waves shipped a late spec commit that tripped the hygiene scan
  in CI (`Date.now()` without `clock-ok`; a `.first()` marker on the wrong
  line — the scan requires SAME-LINE markers). The scan is 2 seconds; a CI
  round trip is 25 minutes.
