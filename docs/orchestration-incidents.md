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

## The wake that wasn't (2026-08-12)

The canary incident above fixed DETECTION — `orchestrator-checkin.sh` reports a
restart reliably now. This one is the layer under it: the detector only runs if
something wakes the session, and that day nothing did. The container restarted
around 21:00Z, and the session stayed silent for 35 minutes until the owner
pinged it. I then reported the restart as though I had caught it. I had not;
the human had.

Root cause: the durable half of the wake pair had been allowed to lapse. Only
in-process `sleep` timers were left, and those die with the container — exactly
like the canary, for exactly the same reason, one level up. So the restart
killed the only thing that could have noticed the restart.

The rule was not missing. `docs/orchestration.md` had said "`send_later` PLUS a
backup background `sleep`, re-arm the pair before ending the turn" since
2026-08-01. What was missing was the reason the pair is a PAIR, and without it
the two look like redundancy — and dropping one of two redundant timers feels
survivable. It is not, because they cover disjoint failures:

- `send_later` is a **server-side routine**. It survives a container restart.
  It is the only thing that does.
- a background `sleep` is **in-process**. It dies with the container. It covers
  the case where `send_later` silently fails (2026-08-01, 52 minutes).

Drop the sleep and you lose cover for a rare failure. Drop `send_later` and the
DOMINANT failure mode — restart, which had already happened twice that day —
has no wake mechanism at all. Hence: **`send_later` is primary, armed first on
every wake, before any other work.**

Two things this cost beyond the 35 minutes, both worth naming:

- **I claimed the catch.** The check-in script correctly printed
  `boot-id: *** RESTARTED ***` when it finally ran, and I reported that as
  detection working. Detection did work; nothing invoked it. A monitor that is
  only read when a human asks is a human doing the monitoring.
- **Prose lost again, in the same file that diagnoses prose losing.** The
  runbook's own standing note is that every rule which could become a script
  should be one. This rule could, and now is: arming `send_later` writes
  `$SCRATCH/.wake` as `<fire-at ISO> <trigger id>`, and
  `orchestrator-checkin.sh` §4 alarms on absent-or-past. Every answer it can
  give is actionable — absent means nothing will wake you, past means nothing
  FUTURE will (you are awake handling it), future is silent. If you arm and
  forget to record, it over-reports and you arm a second wake; an extra
  check-in is the safe direction and silence is not.

Verified against three controls before shipping, per the canary section's last
lesson: no file → alarms, past timestamp → alarms, the real armed trigger →
silent with the remaining minutes printed.

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

## The stall detector measured the wrong thing (2026-08-16)

`dispatch-brief.mjs list` flagged a dispatch on elapsed time since its ledger
entry, which cannot tell one wedged agent from four agents in sequence on one
branch across restarts and review rounds — the normal life of any PR that gets
blocked and fixed. It fired twice in one session on the two hardest dispatches
while both were being written to by the minute (`age=4h59m`, 18 and 170 files
touched in the preceding fifteen). Ignorable-alarm failure again: an alarm that
fires when nothing is wrong teaches its reader to skim the one time it is right.

- **The signal was already in the file.** `worktreeIdleMs` existed for `done`,
  which refuses to remove a tree written in the last ten minutes because "a
  clean tree means everything is pushed, not that nobody is here". So `done`
  and `list` disagreed about how to tell a live agent from a dead one, inside
  one file: `done` would refuse to touch a tree written nine minutes ago while
  `list` called that same dispatch stalled. The fix was reuse, not a mechanism.
- **The threshold was not the defect.** 3x median now measures IDLENESS, and
  since idle ≤ age it can only ever fire later than before — the change removes
  alarms and adds none, which is what made it safe to land under live agents.
- **Re-stamping a ledger entry on handover was the tempting alternative and is
  worse.** `completedDurationsMs` measures from the LAST `active` row, so
  re-stamping shortens every completed duration, shrinks the median, and lowers
  3x it: the false alarms would arrive sooner. Progress needs no bookkeeping and
  cannot drift — #2984's argument, one level over.
- **Progress detection alone would have been blind to the canonical stall.**
  The 12.9 h denied-and-idle agent above had no worktree after thirteen hours
  and never created its branch, so both progress signals are absent exactly
  where the old alarm was merely loud. Absence of a trace is therefore its own
  alarm, qualified by age — the one job age is honest for.
- The 13.7 h unbanked agent is correctly NOT a stall here: it was working.
  Unpushed work is `orchestrator-checkin.sh`'s alarm and already fires.

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

**What the check scans depends on the event (#2949, #2969).** A PR or
merge-queue run scans **that branch's own range**; a `push` to a non-main branch
scans `--log-opts="--all"`, every ref in the `fetch-depth: 0` checkout. Between
#2949 and #2969 every PR scanned `--all`, and the blast radius was the whole
repository: one branch's credential-shaped fixture redded `gitleaks` on **every
open PR**, naming a file none of them touched, until that branch was rebased or
deleted. It was paid for live on 2026-08-16 and the PR check was narrowed to the
range; the accepted cost, recorded in #2969, is that the whole-repo re-audit now
happens per push per branch rather than ~30 times a day.

Two things survive the narrowing. A PR run that cannot resolve its base **falls
back to `--all`** and says so in the step log — under-scanning silently is the
worse failure — so a finding from another ref is still possible on a PR. And a
follow-up commit that DELETES the literal still does not clear it: the scan
reads COMMITS, not tips, so only an amend, a rebase, or deleting the branch
does. The job explains which case it is
(`scripts/gitleaks-explain.mjs`) instead of relying on this page being read.

Once it merges the blob is in every checkout and only rewriting published main
history removes it. The trigger is an
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

## Migration-slot incidents (the era these closed)

The numbered era ended at 185 — migrations are name-keyed now
(lib/migrations/runner.ts), so this class of incident can no longer occur. It
is kept because it is the argument for the change:

- Two agents both wrote `165-*.ts` because one brief never mentioned slots — a
  prompt silent on slots is not neutral, it delegates the choice.
- A correctly-briefed agent still burned a round building a contingency for a
  slot gap that had already been filled — say what is ON MAIN, not only what
  the agent holds.
- A branch appeared carrying a different `Claude-Session:` trailer and
  claiming 167, the slot the map recorded as free — the ledger is
  authoritative only over dispatches it recorded, so unknown remote `claude/*`
  branches get their trailers read, not assumed.
- The renumber recipe (merge, `git mv`, bump id + name + comment, re-hash the
  manifest, grep the old number out of test files, cheap-tier validation) was
  run three times on the #1059/#1061/#1062 train alone. Under name-keying the
  same situation is a two-line `index.ts` conflict resolved by keeping both
  sides.
- Every slot collision in the 2026-08-12 session was a memory error — the
  owner's stated reason for wanting the reservation computed, and half the
  reason the number itself was retired the next day.

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
  `1.0`→`1` edits in `canonical-result-definitions.json` were the only visible
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
- **The unevaluated major**: a TypeScript 5.9→7.0 bump sat `parked` for 35
  days with no evaluation at all — parked-without-a-recommendation is a
  decision deferred to nobody. Hence the eval-within-a-day rule for majors.

## The REQUEST_CHANGES one-way door (#2692, 2026-08-13)

A changes-requested review blocks merging until it is APPROVED or DISMISSED,
and this session type can do neither — both return "not permitted for this
session type", through MCP and REST alike. `main`'s ruleset makes that
unrecoverable rather than merely awkward: `required_approving_review_count: 0`
(nothing needs approving — the block is purely the outstanding review) and
`dismiss_stale_reviews_on_push: false` (it survives every later commit,
including the one that fixes the finding). The author cannot clear it either;
only the human can, by hand. Proven on #2692 at 12:15Z: the finding was real,
the fix landed, and the PR sat unmergeable behind a verdict nobody in the loop
could lift. Flipping the ruleset would be worse — that setting exists to keep a
genuine blocking review blocking. Hence the rule: a hold is a COMMENT review +
`parked` + a plain statement at the top that the merge waits on the finding.

## GraphQL is the scarce bucket, not REST (measured 2026-08-12)

"Prefer REST over MCP" names the wrong limit: MCP _writes_ — reviews, merges,
issue edits, issue comments — are GraphQL, a **5,000**/h pool against REST
core's **15,000**. A review POST failed mid-session at `graphql 0/5000` while
`core` sat untouched at `15000/15000`; roughly twenty merges plus one sweep's
ten issue comments drained the pool inside an hour. Check
`https://api.github.com/rate_limit` and read the `graphql` resource, not
`core` — `core` will look fine.

## Split-brain dispatch (2026-08-13)

Some clusters were dispatched through `dispatch-brief.mjs new` (ledger +
roster + port allocation), some through the Agent tool, which writes neither.
That produced a false RESCUE NOW on a live agent's tree, and it means the
roster — the only state that outlives the orchestrator — is incomplete by
construction. Hence one dispatch path: every dispatch through `new`, and
`adopt <branch>` to bring an already-running, script-less agent under the
ledger + roster the moment it is noticed.

## Relay errors — amplification in restatement (2026-08-13)

Three relay errors in one stretch, one shape — an agent's conclusion restated
with more force than its evidence carries: the analyte column dropped from
#2712's examples, so a reviewer disproved a claim nobody made; #2713's "inert"
amplified into "destructive advice" when the exclusion that made it inert had
been approved hours earlier; and a false clause in a recorded owner ruling on
#2700. The correction is mechanical: quote the agent's evidence verbatim, and
let the conclusion be stronger only where it was re-derived — #2720's finding
held for exactly that reason.

## The write path, not the diff (#2720)

#2720's blocking defect was invisible in the diff, in the tests, and in CI:
the shipped fixture inserted a row shape the app never produces, which is
exactly how it passed. It appeared only by calling `insertVitals` and reading
what actually landed in the column. A review of a write-path change exercises
the write path.

## The merge queue that couldn't (2026-08-13)

Applying `.github/merge-queue-ruleset.json` 422s with
`Invalid rule 'merge_queue'`: GitHub offers merge queue only on
ORGANIZATION-owned repos, and this repo is user-owned — no JSON shape fixes
that. The ruleset file and the `merge_group` workflow triggers stay as the
transfer-ready artifact (inert, zero cost). A strict up-to-date
required-checks ruleset was considered and rejected: it re-runs full CI per
open PR per landing while buying nothing the hand-serialization protocol
doesn't.

## 2026-08-15 — the roster forked because a brief could not be reprinted

A live session lost a dispatch brief's text (it is printed once, at `new`; the
ledger keeps parameters, not prose) and re-ran `new` to get it back. That
appended a second ledger row and a second roster cluster per branch, and the
next check-in printed seven clusters for four live agents.

The roster is the only coordination state that outlives the orchestrator, and
it is read after a restart to decide which dirty worktrees hold unrescued work.
A roster that double-counts is wrong exactly when nothing else can correct it —
the same class as the canary that died with the house.

Two of the four re-runs were REFUSED, by the e2e cap, which is the receipt that
the guard shape works: the non-e2e path simply had no equivalent. Fixed in
`dispatch-brief.mjs` (#2923): `brief <branch>` reprints from recorded
parameters and writes nothing, and `new` refuses an already-active branch,
naming both exits.

## A gate PASS that its own last step invalidated (#2935, 2026-08-15)

`agent-gates.sh` runs `format` LAST, on purpose: a late edit after formatting is
the CI breaker the script exists to prevent. But it had also assumed formatting
is semantically inert. It is not. An agent wrote a `@ts-expect-error` directly
above its erroring call, typecheck passed on exactly that, and Prettier then
rewrapped the call across three lines — sliding it out from under the directive.
The push was red on `TS2578: Unused '@ts-expect-error' directive` plus the
now-unsuppressed error, after a gate block that legitimately read PASS. Nobody
edited anything, so the existing NOTE ("commit them NOW, do not edit") could not
have helped; following it literally is what produced the red push.

The exposed class is gates that read LINE-POSITIONED comment directives —
`@ts-expect-error`, `eslint-disable-next-line`, and the `-ok` pragmas the
e2e-hygiene scan pairs with the line beneath them. The test tiers are immune, a
rewrap changing no runtime behavior, so the script now re-runs only those three
after a rewrite and the cost stays seconds. The agent diagnosed this itself and
declined to edit shared tooling outside its dispatch, which was the right call
and is why the finding arrived intact.

## The wake alarm that lied for a session (2026-08-16)

`orchestrator-checkin.sh` §4 read the wake file with `awk '{print $1}'` and
expected a bare `<ISO> <trigger id>`. The check-in PRINTS the armed wake as
`next: <ISO> <id>`, so an orchestrator recording its own output wrote the label
into the file. `date -d "next:"` refused it, `|| echo 0` turned that refusal into
epoch 0, and 0 is always in the past — so a correctly-armed wake reported as
lapsed at EVERY check-in for a whole session. Three redundant one-shot triggers
were armed chasing it, and two had to be deleted.

Two defects, one line apart. The parser was brittle about the one mistake its own
output invites. And the fallback collapsed "cannot parse this" into "this is in
the past" — two states whose advice sounds identical ("re-arm") but is not:
re-arming cannot fix a format the reader cannot parse, so the alarm survives the
fix and teaches its reader to skip it. That is the canary failure in its third
costume — an alarm that fires when nothing is wrong.

Now the label is accepted, and an unparseable file says so, prints what it found,
and prints the shape it wanted. Verified against five controls before shipping,
per the canary section's last lesson: absent, future bare, future labelled,
genuinely past, and malformed.

## The high-stakes registry read "which subsystem", not "what does a bug disclose" (2026-08-16)

`adversarial-review-brief.mjs --check` answered "not high-stakes" for #2955 — a
rewrite of `redactSecrets`, the function that decides whether a credential
reaches a user's screen. It had answered the same way for #2929's `lib/dri.ts`,
the arithmetic behind an upper-limit safety warning (#2932). Both were overridden
by hand, and both had real defects the falsifying lane then found.

The registry was assembled by SUBSYSTEM — migrations, auth, backup, notifications
— which is why it kept missing files that belong to no dangerous subsystem while
deciding something dangerous. The question it has to answer is not "is this the
auth module" but "what does a bug here disclose, decide, or destroy". Redaction
discloses; DRI decides; a backup destroys. Same tier, three different subsystems.

Two overrides in one session is the signal that the next miss is likelier than a
false positive, so `lib/error-log-format.ts` and `lib/log.ts` are now declared —
and the entry says WHY in disclosure terms, so the next person extending the list
has the right test to apply rather than a list of module names to pattern-match.

## Clustering costs the BOX, not just the review queue (2026-08-16)

The arrival warning (#2973) was written against review depth: dispatch several
at once and their PRs land together, and review is serial. Measured an hour
later, that framing was half the story.

Five agents dispatched in two batches — two, then three within a minute — drove
the load average to **17.70 on 4 cores**, 4.4x oversubscribed and half again the
11.86 that produced two contention misdiagnoses the night before. `ps` said why,
and it was not five agents idling: three vitest tiers, a `next build`, and two
Playwright servers with their browsers, all inside the same minute.

Simultaneous starts are simultaneous GATES, not merely simultaneous arrivals.
Gate cost is the dominant per-agent cost (that is what #2964 scoped), so agents
started together reach the expensive phase together and contend for the same
four cores — which is the mechanism that makes a starved tier fail in code the
agent never touched.

So the cap number was not the defect and lowering it would have been the wrong
correction: five agents SPREAD OUT cost nothing unusual. The evidence points at
pacing, which is what #2973 already warns about — it just understated why. The
warning's own rationale now names both queues it protects.

## A deleted requirement, mistaken for dead code (2026-08-16)

The fasting lifecycle (#2756) listed editability as an acceptance criterion:
_"beyond it, a completed fast's instants stay editable."_ `editFast` shipped in
the first commit, with a comment that shows the author understood the
distinction — _"editing a completed fast's interval is recording fasting
content, not closing out."_

No `editFastAction` was ever written. `git log -S'editFastAction'` across every
ref returns nothing. So from day one there was a write core with no Server
Action and no surface, reachable only from tests.

The first adversarial pass found exactly that and filed **D6: `editFast` is
unreachable (tests only), yet cited as evidence the asymmetry is bounded.** That
was a correct and useful finding — the PR really was citing an uncallable
function as proof its life-stage gate was bounded. The orchestrator relayed it
under _Lower severity_, the author deleted the function, and **nobody checked
the dead code against the issue's acceptance criteria before removing it.**

Five rounds later the fifth adversarial pass found that an implausibly long
recorded fast has no recovery path: reopen refuses, discard refuses, and there
is no edit core. The reason there was no edit core is that the review had
deleted it. The owner then ruled (#2993) to rebuild it — a core plus a surface,
earning its own adversarial pass.

So the loop was: the issue asked for it → it was half-built → review classified
the half as debris → the absence was rediscovered as a defect → it was ordered
rebuilt. Each step was locally defensible. The cost was five rounds and a
rebuild.

**The rule this bought** (`review-merge.md` §Review): a removal is checked
against the issue's acceptance criteria before it is accepted. An unreachable
export can be debris or an unfinished requirement, and the code cannot tell you
which — only the issue can.

Worth separating from the sibling question in the same PR: **delete** was never
fasting-specific. The app's generic delete is Data → Manage, per registered
dataset, and fasting only reached it in #2981 as a side effect of the
`OWNED_TABLES` right-to-delete fix. That was a registration gap. Editability was
a scoped requirement — different failure, different fix.

## The redundancy nobody observed (#2994, 2026-08-16)

Four adversarial passes over one PR, each finding a real defect in the previous
fix's new surface. The fourth is the one worth keeping, because it is the first
that could not have been found by reading.

The logout undo shipped with a comment stating its own invariant: _"TWO
BARRIERS, and neither is trusted on its own"_ — the framework's
`unstable_rethrow` first, the server probe second, the second existing
precisely so that a framework which stopped rejecting on redirect could not make
the first one the whole defence. The mechanism was right. Every gate was green:
927 pure files, 720 db files, the changed e2e specs 17/17.

The refuter deleted each barrier **separately** and re-ran the shipped suite.
Both mutants passed everything. Neither mutant was equivalent — removing the
rethrow widens the failure window from "response lost" to any successful logout
followed by a drop; making the probe unconditional re-admits the previous
round's blocker for every non-redirect rejection. The suite stayed green because
the one test covering that path could not tell **which** barrier had stopped the
undo.

So the redundancy existed in the code and nowhere else. A second guard that no
assertion distinguishes from the first is one mechanism and a comment — and the
comment is the part that survives a refactor.

**The rule this bought** (encoded in `adversarial-review-brief.mjs`'s METHOD, so
it is asked on every high-stakes diff rather than remembered): if a diff claims
redundancy, delete each half separately and run the suite. Each half needs an
assertion that goes RED when only that half is removed. Show the mutant red —
the fixed head being green is not evidence about either barrier.

This is the session's dominant defect class one level up. The first three passes
were guards _true of their own function and false of the system_; this one is a
guard true of the system whose **backup** was unobservable. Same test:
could this control have come out the other way?

## The verdict destroyed by reading it (2026-08-19)

Fourth time the restart detector soothed over dead agents, and the first three
fixes had all widened WHAT counts as a restart — a machine reboot (04:38Z
2026-08-13), then a session restart with the box still up (12:33Z the same day).
The remaining hole was never detection. It was that detection is
compare-then-stamp, so the ANSWER IS CONSUMED BY THE FIRST READ.

At 10:14Z the recorder printed `*** RESTARTED ***` for both boot-id and session
and ran the preserve-first drill. The orchestrator then re-ran it twice, seconds
apart, for the ordinary reason anyone re-runs it: the first output had been read
in slices and the worktree section was wanted whole. Runs 2 and 3 compared
against the ids run 1 had just stamped, found them UNCHANGED, and printed

    wt-biomarker  agent/3050-2937-biomarker-bugs  LIVE  remote=ABSENT  dirty=5
    (no rescue targets — every dirty tree belongs to a live agent)

over five uncommitted files on a branch that existed on no remote. The rescue
happened anyway, but only because run 1 was still on screen; an orchestrator
that had scrolled, or that ran the recorder once more before acting, would have
removed that worktree on the word of the script that was warning about it.

The lesson generalises past this script: **a verdict that a reader can destroy
by re-reading is not a verdict, it is a race.** Persisted state was already the
right instinct — the fix is that the state has to outlive its own first
consumer. `$SCRATCH/.agents_dead` is now raised on detection, answered from on
every later run, and cleared only by an explicit
`orchestrator-checkin.sh --relaunched`. The clear runs BEFORE the raise inside
one invocation, so an ack written for an older restart cannot swallow a newer
one detected in the same run. Cost of forgetting to clear it: a loud reminder.
Cost of never seeing it: an agent's uncommitted work.

## The restart that killed nobody (2026-08-19)

Minutes after the sticky-flag fix above shipped for a recorder that soothed over
DEAD agents, the same recorder cried restart over LIVE ones — and this time the
orchestrator believed it.

At 10:14Z the check-in reported both detectors tripped: boot-id changed, session
identity changed (`532:1118` → `511:1282`), uptime reset to 25m. Everything the
script knows how to look at said the world had been replaced. It had not: the
container had been resumed from a snapshot, so both ids were new and THE PROCESS
TREE WAS RESTORED. `ListAgents`, asked afterwards, showed the two dispatched
agents still RUNNING, 33 and 34 minutes in — straight through the "restart".

Acting on the verdict, the orchestrator ran the preserve-first drill (correct,
and it did rescue five genuinely unpushed files) and then relaunched both
dispatches (wrong). That put **two writers on one worktree, on two branches at
once**. What saved it was not the tooling:

- the biomarker relaunch noticed a `git rm` racing its own, watched a file get
  rewritten during a 20-second sleep it ran deliberately to test for a live
  writer, wrote nothing at all, and stopped to ask;
- the intake relaunch made no source change and no GitHub write, but did run the
  full unit and DB tiers inside a tree its sibling was editing — a
  phantom-failure generator that had to be relayed to the owner so a contended
  red would not be chased as a regression.

The rule this bought is asymmetric, and the asymmetry is the whole lesson:

- **RESCUE on the verdict.** Committing a dirty tree costs a junk commit if the
  agent turns out to be alive, and saves unrepeatable work if it is not. A proxy
  is good enough to authorise something that cheap.
- **RELAUNCH only after confirming liveness with something that actually knows**
  — `ListAgents`, never the recorder. A relaunch onto a live agent IS the
  two-writers accident, and it violates the standing rule against editing a live
  agent's worktree without an acknowledgement; the relaunch is the edit.

Generalised: a proxy may raise an alarm, but it may not authorise the
destructive response to that alarm. Both directions of this detector are now
receipted — soothing over the dead (four times) and alarming over the living
(once, and one careful subagent away from losing work).

## The lane I retired out from under a live agent (2026-08-19)

PR #3176 merged. I closed its ledger entry with `--keep`, then removed its
worktree by hand with `git worktree remove --force`. An agent was inside that
directory running gates. The directory vanished mid-run, taking an uncommitted
fix with it — the one remaining item from the review that PR was closing — and
the run reported `GATE format (LAST): FAIL (exit 2)` followed by `pwd: error
retrieving current directory`.

The agent reported the unexplained gate failure instead of quietly re-running,
which is the only reason the cause was ever identified rather than filed as a
formatting flake.

It then diagnosed the cause as the brief having coupled it to a path from a
previous dispatch (#3172 reused #3163's `wt-e2e-leak`). That is wrong, and worth
recording as wrong: the coupling determined WHO was standing there, but the
removal is what did it. I had said, after deleting `.next` from three live trees
earlier the same day, that I would ask before touching an agent's worktree. I
then did it again under a tidier name — "retiring a lane" — and did not notice
that it was the same action.

Two guards, because the two failures are different:

- A worktree path now belongs to one dispatch forever, retired ones included.
  Reusing a retired path couples two lanes to one directory and the coupling only
  shows itself at retirement, when the removal lands on whoever is there now.
- Retirement now asks whether a PROCESS is standing in the tree, not only whether
  the tree was written recently. The agent's own point, and it is the sharper
  one: its git state was clean and its branch was merged, so every proxy said the
  lane was safe to reap. What was live was a gate run — and this project's own
  brief tells agents to write logs to `$SCRATCH` rather than into the worktree,
  so a long tier can run for minutes touching nothing inside it. A process whose
  cwd is in the tree is not a proxy for occupancy; it is occupancy.

Generalised, and this is the third time today the same shape has appeared: a
proxy that answers a cheaper question than the one being asked will agree with
the real answer right up until the case that matters. A clean tree meant
"everything is pushed", not "nobody is here".

## The PR I retired off my own board (2026-08-19)

`agent/3180-3206-test-hygiene` opened PR #3212 and I retired the lane. The PR was
open, green, and unmerged. Retiring closes the ledger entry and the roster row,
and between them those are the whole board — so the PR did not become
lower-priority, it stopped existing as far as the orchestrator was concerned. It
sat there for an hour while I merged four other PRs and dispatched three lanes.

It was found by accident. Disk was down to 2.4G with three trees live, I went
looking for space, and `git worktree list` showed a worktree for a lane the
ledger said was finished. Only then did asking why produce the PR. Had disk been
comfortable, nothing in the system would have raised it: no check-in reads
GitHub, and the roster — the one thing that does get read after a restart — had
already been told the lane was done.

The signal was not missing. It was computed, and discarded. The retirement path
pruned, asked whether `origin/<branch>` still existed, and used the answer to
decide whether to delete the LOCAL branch — printing `kept local branch … — its
remote still exists (not merged?)` when it did. That line was on my screen. It
appears _after_ the worktree has been removed and the ledger entry closed, as
prose, with a question mark. A squash-merge deletes the remote head branch, so
that ref surviving a prune is not a hint that the work might be unmerged; it is
proof that it is.

The fix hoists the same fact ahead of every destructive step and refuses on it,
with `--keep` as the way out for a genuinely abandoned branch. The decision is
now `retireVerdict`, a pure function, pinned in
`lib/__tests__/dispatch-retire.test.ts` in both directions — because a guard that
refuses ordinary clean retirements would be routed around within the hour, and
then the second direction would not exist either.

The shape is one this file already names twice, arriving from a new angle: a
warning that fires after the last moment it could have helped is not a weaker
guard than a refusal, it is not a guard. Both of the other retirement guards in
that file say so in their own comments, and I wrote those comments. The check
that got this wrong was sitting between them.

## Two greens against two different bases (2026-08-20)

`main` went red on `mobile-clipping.mobile.spec.ts:206` — a dialog body scrollable
by 5px, on a spec that had been 18/18 green on its own PR that morning.

Both halves were green, and neither green was about the tree that resulted:

|                                                                    | merged     | its CI base        |
| ------------------------------------------------------------------ | ---------- | ------------------ |
| #3379 — adds the spec, scopes `FoodLogBar`'s bleed to `md:`        | `bc329883` | main without #3370 |
| #3370 — `ModalShell` / `DirtyFormRegistry` / the dirty-form marker | `e050a80b` | main without #3379 |

Twenty minutes apart. Both 18/18. I verified each head's `check-runs` myself, which
is the discipline this file already argues for, and it did not help: the check runs
were real, complete, and computed against a base that no longer existed by the time
the second merge landed.

Two different shards then failed at exactly **5**. That number is the useful part of
the receipt: co-residency and contention give timeouts, or they give different numbers
each run. The same wrong value from two different neighbour sets is a deterministic
fact about the tree, and it ruled out the whole contention branch before anyone spent
a cycle on it.

The gap is that `mergeable_state` does not model this. A branch whose checks predate
another merge still reports `clean` — `behind` is about the branch's commits, not
about when its checks ran. So the reassuring field says the reassuring thing, and the
runbook's existing "a behind-only PR's green can be stale" caution never fires,
because the PR is not behind.

The rule now in the pipeline is a timestamp comparison: a second merge needs checks
whose `started_at` is later than the previous merge. It is one REST read, and it is
the only thing that distinguishes "green" from "green about this tree".

Worth naming the shape, because it is the same one this file keeps recording from new
angles: **a check that answers a cheaper question than the one being asked.** "Were
these checks green?" is cheaper than "were these checks green about the tree we are
about to create", and the first is what every available field reports.
