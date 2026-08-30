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
discipline. The zero-revert run ended on 2026-08-26, when #3800 was merged on
green CI and reverted by the owner the same session — see below.

## The review that checked the arithmetic (2026-08-26)

#3800 implemented #3555's ruling that the ENTIRE Standing row is the link
surface. It used a stretched pseudo-element reaching out from the facts cell by
two custom properties. The review verified those at `sm` (12rem) and
`min-[45rem]` (13rem), found both correct against the grid template, and said
so: "every breakpoint the properties change at is a breakpoint the template
changes at." True, and the wrong question.

Below `sm` the row is a single-column grid, so the name cell is its own grid
row. The surface, anchored in the facts cell with `top:0;bottom:0`, never
covered it. At 390px — the phone width #3555 is about — "the entire row is the
link" was false. The review had checked the two breakpoints where the values
changed and never rendered the base case.

A second defect had the same shape. The PR shipped an e2e asserting the date
stays visible while the door shows, and the review recorded that the guard
existed. It never asked which widths the guard ran at; the door still covered
age content at widths that spec never visited, which the rebuild proved
separately at 720px and 1280px.

The owner reverted the merge and rebuilt it at -453 lines, deleting the
stretched pseudo-link, the custom properties, the hover-census registration and
the commentary. Both misses share one root: the review confirmed the
implementation was internally consistent instead of rendering the condition the
ruling names.

Same session, three PRs (#3635, #3690, #3633) were closed for rescope and a
just-merged test file was rewritten from separate `it()` blocks into
`it.each()` tables at a quarter of the length. The dispatch template asked for
thorough guards and reasoned comments and never said where thorough stops; that
bar now lives in the brief generator.

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

## The merge-base rule, and what it cost to follow literally (2026-08-20)

The rule added earlier the same day — a second merge needs checks that ran on a base
containing the first — fired **four times within ninety minutes** of being written.
Three of those were real:

| PR    | stale against | shared surface                                                               |
| ----- | ------------- | ---------------------------------------------------------------------------- |
| #3388 | #3386         | `QuickEntryProvider.tsx` — the exact host the other's assertion measured     |
| #3392 | #3388         | dialog body chrome vs. an assertion on a dialog body's scroll extent         |
| #3396 | #3392         | **none** — `FoodLogBar` CSS and one mobile spec, against `lib/` data-quality |

The first two justified the cycle. On #3388 the interaction was closer than the file
list suggested, and only reading the diff found it: I had flagged it as "dialog body
chrome" while what it actually changed was the host the other PR measured.

The third is the problem. Merges were landing every ten minutes or so, and a rule
that says "re-run whenever a merge happened during your CI" makes every PR
perpetually stale in a busy hour — which is not a strict rule, it is a rule that gets
abandoned. That is worse than a rule with a stated exception, because the abandonment
is silent and nobody records when it started.

So the step now reads: re-run, **or write down why the two file sets cannot
interact**. The judgment is allowed and the judgment is written, which is the whole
difference from where this started. The failure that produced the rule was not a
missing check — it was "I judged the risk low" as an unstated assumption. A stated
one can be read back, disagreed with, and found wrong afterwards.

Worth noting what the check costs: one REST read of each PR's file list, compared for
overlap. On #3396 that was ten filenames against two, with no path by which nutrition
CSS could change a data-quality finding's existence or a query count.

## The head you read and the head you merge

#3418. CI verified green on `9959c178`. The full-diff review was written against that
diff and posted. The merge call went out, and GitHub merged `b36a2bc1` — a merge of
`origin/main` the lane pushed in the ninety seconds between.

Nothing was lost: `b36a2bc1` was `9959c178` plus current main. But the review credited
an argument the lane had already retracted in its final commit — the no-`FactEditorHost`
decision was justified by what #3409 would cost, and #3417 had made that cost
disappear hours earlier. The lane knew. The review, written one commit behind, did not.

"Green CI on the exact head" was followed. Its unwritten second half was not: the exact
head has to still be the head when the merge call goes out. One request answers it.

The general shape: verifying a fact about a moving object and then acting on the
verification some time later is not the same as acting on the fact.

## The flight recorder that had nowhere to land (2026-08-21)

A fresh container's first check-in ran before `$SCRATCH` existed. `STATE_DIR`
was computed but never created, so every write the recorder makes —
`.boot_id`, `.session_id`, `.agents_dead` — failed with "No such file or
directory". Those failures scrolled past as three shell errors among fifty
lines of normal output. The compare that follows a failed stamp reads
`MISSING`, and `MISSING` is indistinguishable from "the container restarted".

So the recorder declared a restart that never happened. Sixty-two minutes
later the follow-up check-in — same boot-id, `up 62m`, four subagents that
`ListAgents` reported as `running` — printed:

```
wt-forms-discard forms-discard-confirm  DONE  dirty=1  <<< DIRTY AND NO AGENT: RESCUE NOW
```

over a **live** agent's worktree. That verdict authorises the preserve-first
drill: commit whatever is in the tree as a WIP rescue and push it. Performed
against a running lane, that is two writers on one worktree — the thing the
runbook forbids everywhere else, reached by following the runbook.

Nothing was lost, because `ListAgents` was checked before anything was
written. That check is only in the procedure because
[the restart that killed nobody](#the-restart-that-killed-nobody-2026-08-19)
put it there: the verdict authorises the rescue, never the relaunch, and it is
worth confirming even the rescue when the trees belong to agents you started
yourself and never saw die.

**This is the sticky-verdict defect in the other direction.** That fix stopped
the recorder soothing over dead agents; this one stopped it screaming over live
ones. Every earlier fix widened _what counts as a restart_ — none asked whether
the recorder could write at all. A detector whose alarm is wrong in either
direction stops being read, and the direction that manufactures destructive
work is the worse one.

Two changes, both in `scripts/orchestrator-checkin.sh`:

- `mkdir -p "$STATE_DIR"` before the first compare, and a hard non-zero exit
  with no verdict at all if the directory cannot be created. An inoperative
  flight recorder must never be mistaken for one reporting bad news.
- Every stamp write is checked. `mkdir -p` succeeding does not prove the write
  succeeds — a full disk or a read-only mount fails there and nowhere else —
  and the cost is paid by the NEXT run, which reads `MISSING` and cries
  restart at a live fleet. A failed stamp now says so, and says what it will
  cause.

The general shape, worth carrying to any state-based detector: **a detector
that cannot persist its state does not fail closed, it fails LOUD AND WRONG.**
Absent state and changed state are the same reading. Check that you can write
before you trust what you read.

## The recorder that could not stamp when you only read the top of it (2026-08-21)

A real container restart at 05:42Z killed a five-agent fleet. The drill worked:
`ListAgents` confirmed the fleet dead, three dirty worktrees were committed as
`WIP RESCUE - no gate has been run` and pushed, the fourth was already banked,
all four were relaunched, and `--relaunched` cleared the sticky flag.

Then the next three check-ins each reported the SAME restart, and one of them
printed `DIRTY AND NO AGENT: RESCUE NOW` over a lane that `ListAgents` showed
`running`. Clearing the sticky flag had not helped, because the flag was not
the stale thing.

**The cause was the reader, not the recorder.** This script prints ~40 lines
and stamps the boot-id and session-id at the very END — deliberately, so a
crash mid-check-in still reports the restart next time. Every one of those
check-ins was read as `orchestrator-checkin.sh | head -N`, which is the
natural way to look at a long report and exactly what "run it as the FIRST
action of every check-in" invites. `head` closes the pipe after N lines, the
next `echo` takes SIGPIPE, and the script dies before the stamp block. The
stored boot-id stayed at its pre-restart value, so every later run compared
the kernel's id against a stale file and correctly concluded "different" —
about a restart that had already been handled.

Proof, and it is a one-liner: the same script run WITHOUT a pipe exits 0,
prints `boot-id stamped`, and the following run says `UNCHANGED`.

Fix: `trap '' PIPE` at the top. A closed stdout now costs the unread tail of
the report and nothing else; the state writes are not stdout. Verified against
the failing invocation itself — with the stored id reset to a junk value and
the output piped through `head -5`, the stamp still lands and the next run
reports `UNCHANGED`.

**This is the third direction this one alarm has been wrong**, and the three
together are the real lesson:

1. It soothed over dead agents, because reading the verdict consumed it —
   fixed by making the verdict sticky.
2. It screamed over live agents, because `$STATE_DIR` did not exist and every
   stamp write failed silently — fixed by `mkdir -p` plus a hard exit when the
   directory cannot be created.
3. It screamed over live agents, because the reader truncated the output and
   killed the process before it could stamp — fixed here.

Every one of them is the same root: **the recorder's OUTPUT and the recorder's
STATE are different things, and each failure broke the state while the output
still looked fine.** A state-based detector has to be judged on whether its
write happened, never on whether its report read plausibly. When an alarm you
have already acted on fires again unchanged, suspect the write before you
suspect the world.

Corollary for anyone extending this script: nothing that runs AFTER the last
`echo` may be load-bearing unless the process is protected from its own
stdout.

## The line budget (2026-08-27)

Seventeen orchestrated merges added **+6,382 net lines**. The owner called that
too much growth and ruled: design convergence must be **production-negative**,
and no diff may introduce a scanner, registry, allowlist, variant, or
compatibility layer.

The composition is why the second half of the ruling is separate from the first.
By path, that +6,382 was:

| path                      | net    |
| ------------------------- | ------ |
| `__tests__` / `*.test.ts` | +3,382 |
| `e2e/`                    | +1,372 |
| production                | +1,222 |
| `scripts/`                | +219   |
| docs                      | +187   |

**Three quarters of it is proof, not product.** Production averaged ~72 lines a
merge across seventeen. So a rule aimed only at production lines would have
reached a fifth of the growth, and a rule that cut test volume would have reached
the layer that caught the four blocking defects that session — a manifest refusal
bypassable by deleting a key, a partial-save message that turned a duplicated
weigh-in into a silently lost one, "Reconnect" written onto pages that hide the
reconnect control, and a body-less 400 that stopped a source syncing forever.
None was caught by CI. All were caught by tests written to be red first.

The available slack is **verbosity, not coverage**, and it is measured: the owner
rewrote one lane's tests from `it()` blocks to `it.each([...])` tables at
−212/+67 — identical assertions, a quarter of the lines. Compact the proof before
questioning whether to have one.

Encoded in `scripts/orchestration/dispatch-brief.mjs` (LINE BUDGET) and
`docs/orchestration/review-merge.md`.

## The fixture that told the time (2026-08-27)

`main` went red at 17:00 UTC on a spec nobody had touched. It would have gone
green again on its own at midnight.

PR #3835 closed #3573 by converting seven surfaces from the UTC truncation of a
stored instant to the profile-local calendar day. The change is correct and its
author proved it — a table over both sides of UTC, Pacific/Auckland and
America/Los_Angeles, at the unit tier, exactly as the issue asked.

What moved with the render was the meaning of every fixture feeding it.
`e2e/patient-portals-setup.spec.ts` still seeded naive instants:

```sql
VALUES (?, ?, ?, '2026-01-02 03:04:05', '2026-01-03 03:04:05', 2, ?)
```

`e2e/pinned-timezone.ts` pins the instance zone at offset `13 − utcHour`, so it
is west of UTC for every run starting after 13:00. From 17:00 the offset reaches
−4, `03:04` falls back across midnight, and the row renders `first seen
2026-01-01` against an assertion naming `2026-01-02`.

Seventeen hours green, seven hours red. That is why #3835's own CI passed, why
the failure surfaced on an unrelated PR whose diff was two lines of JSON, and
why it reads as a flake to anyone who looks in the morning. A re-run never
clears it — the run's start hour picks the zone.

Feeding both fixture shapes through the app's own `dateFromCreatedAt` at each of
the 24 zones the rotation can draw:

```
naive breaks  utcHour=17 Etc/GMT+4  2026-01-02 -> 2026-01-01
…
naive breaks  utcHour=23 Etc/GMT+10 2026-01-02 -> 2026-01-01

fixed wrong: 0/72   naive wrong: 15/72
```

A second stamp in the same file, `portal last checked 2026-01-05`, was one hour
a day from the same failure: `09:00` only crosses midnight at the western
extreme.

Three things this bought, all of them already stated somewhere and none of them
connected:

1. The #1417 fixture rule covered fixtures whose feature _already_ grouped by
   profile-local day. It said nothing about a fixture that becomes local-dependent
   because a render was converted underneath it. The dispatch brief now says both.
2. A green e2e run is evidence about one timezone — the one that run's clock drew.
   Proof has to enumerate the zones, which is cheaper than running the spec twice
   and strictly more conclusive.
3. "I checked and there is no fixture here" and "I did not check" are the same
   sentence in a report that omits both. The brief now asks for the negative
   explicitly, per site.

The cost was bounded only because the failure landed on a two-line release-notes
PR, where "my diff cannot have caused this" was obvious enough to check properly
instead of re-running. On a larger diff it would have been absorbed as a flake.
#3836 converts roughly eight more of these sites; without the rule it would have
recurred once per site, each with a seven-hour daily window and a plausible flake
story attached.

Filed as #3878; fixed in #3866.

## The census that counted filenames (2026-08-28)

#3673 removed the frame from every card below `40rem` — border, radius, shadow, and
horizontal padding, in one unlayered media block. A change like that does not break
code; it breaks the specs that pinned the old rendering. Finding those specs _is_ the
work, and the lane did it twice.

The first pass counted the phone-rendering population as 64 files, on the strength of
the `*.mobile.spec.ts` suffix. That suffix is a naming convention, not a viewport
census: any spec can call `setViewportSize`, and many do. Told so, the lane rebuilt
the population at 126 files, ran 15 signature-hit files (149 tests) and 85 more on a
wider net, and reported:

> `trends-metric-pages.spec.ts` was the only spec pinning the pre-#3673 arrangement.

The next CI run went red on `e2e/cycle.spec.ts:137`, at 390px, on
`expect(box.border).toBeGreaterThan(0)`.

The rebuilt population was right; the signature was wrong. Three things hid that spec
from a search that had the correct file list in hand:

1. **The property and the matcher are on different lines.** The spec reads
   `borderTopWidth` inside a `page.evaluate` and asserts on the returned local. Grep
   for `borderTopWidth.*toBeGreaterThan` and it does not exist anywhere in the file.
2. **The viewport literal is loop-bound.** `for (const width of [390, 1280])` never
   writes `setViewportSize({ width: 390`. A search for the call form misses it.
3. **The filename is `cycle.spec.ts`.** Desktop-named, phone-asserting. This is the
   first failure repeating in a second form: the corrected population was carried
   forward, the correction's _reason_ was not.

What generalises is not "search harder". It is that a census has two halves — the
population and the signature — and a lane that gets one wrong tends to report the
whole thing as clean, because a search that returns nothing looks identical whether
the hole is in the file list or in the pattern. Both halves are now named in the
dispatch brief, along with the instruction to report a census as a per-file table
with the search that produced it, so a reviewer can see which half was tested.

The failure was cheap here: one red shard on an unmerged PR, caught before merge, on
a change whose whole purpose was to move the value the spec asserted. It is cheap in
exactly the cases where the change is obvious. The expensive version is a census run
against a subtle change, reported clean, believed.

## The guard that could only fail one way (2026-08-28)

#3673 removed the frame from every card below `40rem`. The guard written for it walks
`main`, collects every element that still draws a border and a radius, and asserts the
list is empty. It was empty. The change was correct, the sweep was green, and the
adversarial pass found this on `/medications` at 390px:

| element                                                              | border | radius | background         | padding-left |
| -------------------------------------------------------------------- | ------ | ------ | ------------------ | ------------ |
| the drug-interaction / allergy / pharmacogenomic / ototoxicity strip | `0px`  | `0px`  | `rgb(244,248,240)` | `0px`        |
| `medications-today`, an ordinary card                                | `0px`  | `0px`  | `rgb(244,248,240)` | `0px`        |
| `medication-list`, an ordinary card                                  | `0px`  | `0px`  | `rgb(244,248,240)` | `0px`        |

Identical in every measured property. The content of the first row was _"Major ·
Warfarin + Ibuprofen — … sharply raising the risk of serious (especially GI)
bleeding."_ Three rose sentences flush to the page gutter, in a band indistinguishable
from the list of medications above it.

The ruling had anticipated this. #3673 registered the tinted Notice family as its one
exception precisely so that a warning would have something to reach for once the
neutral frames were gone. The implementation honoured that faithfully — `data-notice`
emitted by the primitive, module identity rather than a path list, a compile-time tone
census, a forged-frame positive control. What nobody checked was whether the app's
safety copy actually goes through the primitive. It mostly does: 21 `Notice` call
sites, integration re-auth, UL hazards, RDA findings. The medication safety strip is a
plain `.card` whose findings are `embedded`, and `embedded` draws nothing.

Two more of the same shape: the ASHA ototoxicity threshold-shift warning was
`card border-amber-300` — a _border colour_ as its entire signal, erased completely
when the border width went to zero — and the dashboard's active-illness rail was
`border-l-4 border-l-rose-500`, on a route the sweep actually visits.

The generalisable part is not "audit your safety surfaces". It is this:

**A guard that proves a removal cannot also prove the property survived where it was
load-bearing.** "Nothing still has it" returns an empty list on the tree you wanted and
on the tree where the thing vanished from somewhere that needed it. One assertion, two
very different worlds, one green. The direction is baked into the shape of the check,
so no amount of extending its route list fixes it — the sweep could have visited every
page in the app and still passed.

The fix is to write the converse in the same commit: the named surfaces that must
_still_ carry the property, asserted as a comparison between two real elements on the
same page rather than against a constant. Short and hand-written — an exhaustive
scanner is the shape the owner's line-budget ruling forbids, and it would be the wrong
instrument anyway, because the question is which surfaces are _meant_ to be loud, and
that is a judgment no scan can make.

Both halves are now in the dispatch brief. The PR was parked at green rather than
merged; the cost was one review round.

## The criterion that survived its own defect (2026-08-28)

#3673 ruled that below `40rem` no card draws a frame, and gave the ruling a criterion:
**every text run's left offset equals the page gutter.** PR #3897 implemented it, the
sweep measured it, eighteen CI shards went green, an adversarial pass attacked the
change from two directions and found a real flaw elsewhere. It merged.

Three hours later the owner opened the dashboard on a phone: _"now there's no left
padding on the sections, it looks broken."_

It was. `.card` sets `background: var(--surface)`, and the shell insets its content by
`max(1rem, env(safe-area-inset-left))`. Removing the card's internal padding while
leaving the fill inside that gutter produces the one arrangement where a band's first
character touches the edge of the fill it is printed on. Three elements on the dashboard
at once.

**The criterion was satisfied the whole time.** The text really was at 16px from the
viewport. What nobody measured was the text's distance from _its own fill_, which was
zero. Both are honestly described as "left offset", and the ruling's own words named the
right shape — _"a full-bleed `--surface` fill"_ — but the criterion written to enforce
it measured the wrong one of the two distances.

That is the whole lesson, and it is not "test more". A guard measuring an **absolute**
cannot see a defect that lives in a **relationship**. Text-to-viewport and
text-to-its-container are different numbers; only one of them is what a person looking
at the screen perceives, and the criterion picked the other. Every geometric assertion
has this fork in it — a control 44px tall inside a row that clips it, a gutter correct
against the page and wrong against its container, a gap right at one breakpoint and
measured at another.

Worth being precise about how much scrutiny this survived, because "the review was
sloppy" is the comfortable reading and the wrong one. The diff was read line by line;
the cascade arithmetic was checked and was right; the `!important` layer inversion was
caught and correctly handled; the exception mechanism was verified as module identity
rather than a path list; a positive control proved the sweep could see a frame; an
adversarial lane found that the medication safety strip had gone flat and that was
fixed before merge. Nobody asked what happened to the _fill_ when the padding came off.
The question was one clause away from questions that were asked, and the guard's shape
made it invisible.

Third instance in one day of a guard measuring the wrong property — after a census keyed
on the wrong signature, and a removal guard with no converse. All three now sit together
in the dispatch brief, because they are one family: **a green assertion is a claim about
what it measures, never about what you meant.**

Filed as #3920, at P1, with the fix decided: the band cancels the page gutter on its
frame and keeps it on its content, per side, mirroring the shell's own
`max(1rem, env(safe-area-inset-*))` rather than assuming `1rem` — because the two sides
differ on a notched device in landscape, and a symmetric cancel would pass the default
case and leave a visible step in the one that matters.

## The selector a function built (2026-08-28)

#3548 moved a set of dashboard rows into a collapsed tail. The lane building it did the
right thing and ran a census: which specs address a row that changed band? It searched
the band's markers — `data-standing-*`, `dashboard-standing`, `standing-door`,
`now-strip-empty` — found thirteen files, checked them, and shipped. Two shards went red.

The two misses are worth separating, because only one of them is the old lesson.

`machine-date-census.spec.ts` addresses its row as
`[data-candidate-id="labs.latest:Selenium"]` and never uses the word "standing" — the
familiar signature problem, and a wider token set finds it.

`dashboard-vitals-recency.spec.ts` calls
`dashboardCandidatePrefix(page, "labs.latest:")`. **There is no selector in that file at
all.** A function assembles it. No search for `data-candidate-id`, however carefully
spelled, can see this spec, because the attribute is not there to be found. The token set
had to include the helper's NAME, as a symbol, beside the markup it builds.

The lane found this itself on the second round, and the number it produced is the part
worth keeping: it widened the census from 13 files to 25, then **intersected** with the
rows that actually moved band, which cut 25 back to 6. Six files addressed the thing that
changed; the original census had seen four. Neither the 13 nor the 25 was the number that
mattered — the intersection was, and it is the only one of the three that can be checked
against reality.

Fourth clause now in the census rule. The family they belong to is unchanged: a search is
a claim about a spelling, and the code is under no obligation to spell it.

## The invariant that lived in a React key (2026-08-28)

PR #3919 appended six lines to the day's release notes, two each from three PRs that had
done two separable things. `lib/__tests__/release-notes.test.ts` passed, 34 tests. Shard
11 went red on a locator:

```
strict mode violation: getByRole('link', { name: '#3897', exact: true })
  resolved to 2 elements
```

A release-notes day can only carry one bullet per PR. Two places assume it and neither
says so: `app/(app)/whats-new/page.tsx:130` keys the entry `<li>` by `entry.pr`, and the
spec locates each entry's link by an exact `#<pr>` name. Thirty-three prior days happen to
satisfy the rule, so it had never been tested. The validator refuses a duplicate _date_
and says nothing about a duplicate _pr_, and the model's own doctrine says the unit is a
**change**, not a PR — so the data was arguably right and the code arguably wrong.

Two things to keep from it.

The first is that the failing assertion was not the defect. The locator was the messenger;
the duplicate React keys were the bug, and they would have shipped silently — a `key`
collision does not fail a test, it just makes reconciliation wrong in ways nobody looks
for. The spec caught the data, and the data caught the page.

The second is about who fixes it. The unblocking move was data-only — collapse the three
pairs, land the notes, one bullet per PR — because the model change is production code
with tests and the orchestrator does not write production code to unblock itself. It is
the same discipline as sending an E2E red back to its author: the cheap local fix is
available and taking it is how a workaround becomes the permanent state. Filed as #3940
with both options written out and the decision left to whoever takes it.

## The skip that was defended by a neighbour (2026-08-28)

#3933's sweep corrects a profile's other live Telegram messages the moment a tap moves
the ledger, instead of leaving them wrong for up to an hour. The lane built it and, on
a constraint I wrote, excluded the message that was actually tapped:

> its handler has just rebuilt it from the same state the sweep would read, so a second
> edit is a flicker and a wasted call.

The lane deserves credit for how it handled that constraint. I had written _"either
exclude the tapped pointer, or prove the rebuild is idempotent and assert it — do not
assume it"_, and predicted the failure would look fine in a unit test. The lane ran the
experiment: it made the sweep INCLUDE the tapped pointer, and every "edited exactly
once" count stayed green across 147 tests. It kept the exclusion anyway, added a guard
that could fail, and reported its end-to-end assertion as _"true but non-discriminating"_
rather than as proof. That is exactly right, and it is the reason the adversarial pass
had something honest to work with.

The pass still found it. The justification is true of handlers that re-render through a
domain builder and **false of every handler that ends in `updateMessageKeyboard`** —
which syncs the keyboard column and never `body_hash` — and structurally false of the
_prose_ message class, where the handler and the sweep compute different things. The
digest declares a prose reconciler. So tapping "🔕 No thanks" on the digest's own
time-suggestion writes, strips the buttons, and then the sweep skips the digest: the one
thing in the system that can correct that sentence never runs, and the message keeps
asserting _"your sleep data usually lands by 07:40"_ for the rest of the hour.

The measurement is the part worth keeping. With the exclusion: zero text edits at tap,
one at the next tick. Without it: one text edit at tap, zero at the tick. **One edit
either way.** There was no flicker to prevent and no call to save — the exclusion bought
nothing and cost the feature its whole purpose on the one message kind that needed it.

So the fix is a deletion, and the general lesson is about a shape rather than about
Telegram. A skip is a claim about what some _other_ function already did. It is written
in one file about behaviour that lives in another, so it is true of the handlers the
author had in mind and quietly false of the ones they did not — and unlike a wrong
assertion, a wrong skip emits nothing to be caught. The corollary is cheap: before
writing the justification, remove the skip and measure both sides. If the numbers match,
the skip was never load-bearing.

Two smaller things fell out of the same pass, both worth recording because they are the
same defect wearing different clothes. The guard that was supposed to prove the exclusion
worked could not fail at the call site: neutering the pointer lookup — profile scoping
and all — failed nothing across 113 tests, so it was live code no assertion observed. And
the test comment claiming _"remove the exclusion and this reads 2"_ was false; it read 1,
and it contradicted the lane's own correct note sixty lines below. Deleting the mechanism
deletes all three.

## The alarm that could not tell a lapse from an unrecorded arm (2026-08-29)

The check-in's wake block reported `WAKE IS IN THE PAST (2026-08-28T01:17:00Z)` at three
consecutive check-ins while two durable wakes were in fact armed. Nothing was wrong with
the alarm's logic: `/home/user/scratch/.wake` genuinely held a stale timestamp, because
arming a wake and recording it are two separate acts and only the first has a tool behind
it. The orchestrator armed at 04:23 and again at 05:20 and wrote neither down.

What made it worth fixing rather than remembering is the shape of the two messages. The
**absent-file** branch already printed the exact command to record a wake. The **past**
branch printed only "Re-arm send_later NOW". So an orchestrator in the state that
actually occurs — wake armed, file stale — did the thing the alarm asked, saw the identical
alarm at the next check-in, and had no way to distinguish "my wake lapsed" from "I never
wrote the file". That is the ignorable-alarm failure this script exists to avoid, and it
is the second time this file has recorded it about this same block: the 2026-08-16 entry
is an orchestrator copying the check-in's own `next:` output back into the file and
getting a correctly-armed wake reported as lapsed at every check-in.

The fix is two lines — the past branch now prints the record command too — and the reason
it belongs in the script rather than in anyone's habits is the sentence #3948 was filed
under the same day: _a defence that depends on the writer being correct is not a defence._
The step that gets skipped is the write, so the reminder has to appear in every branch
that notices the write is missing, not only in the branch where the file does not exist
at all.

Both branches were exercised before the change was trusted: a scratch `SCRATCH` with a
stale `.wake` for the past branch, and the live state file for the healthy one.

## The intersection that could only agree with itself (2026-08-29)

`#3954` moved every segmented option, checkbox and calendar day from a rendered 44 onto
the 34px control box. The lane ran a spec census, reported it as a table with a per-file
verdict and the searches that produced it, converted the two specs that pinned the old
value — and CI went red on a third, `quick-log-stability.mobile.spec.ts`, asserting
`optionBox.height >= TAP_FLOOR_PX`.

The orchestrator's first reconstruction was wrong in an instructive way. The failing
line sat directly under `await expect(option).toHaveAttribute("aria-pressed", "true")`,
so the obvious reading was that the locator had been built from a role and state rather
than from the `data-segmented-option` marker — the "selector may be built by a helper"
clause the brief already carries. That reading was checked against the file and it does
not hold: line 129 is `track.locator("[data-segmented-option]")`, and the file **was in
the marker sweep's own output**, one of the fifteen hits the lane listed.

So the defect is one step earlier than any question about selector shape. The lane ran
the broad geometry-pin grep FIRST, judged it "too broad" at 40 files, discarded it, and
narrowed to the marker sweep's hits — then adjudicated those by reading filenames. An
intersection scoped to what a sweep already matched **can only confirm that sweep's
verdicts; it is structurally unable to contradict them.** It feels like corroboration
and proves nothing. And a per-file verdict asserted without opening the file is not a
census result at all; it is the guess the census existed to replace. `TAP_FLOOR_PX` was
on line 167 of a file the sweep had already handed over.

Re-run in the correct order — pin set built first and unscoped over all of `e2e/`, then
intersected with the moved subjects — the population was 45 files, 15 after
intersection, and it found a **second** real case the marker sweep could never have
reached: a genuine `SegmentedControl` in `ride-detail.spec.ts` addressed purely by
`getByRole("group", { name })`, where the accessible name comes from an `ariaLabel`
prop. That one pins width rather than height, so it was green, and it was run rather
than reasoned about.

Two smaller things worth keeping. The CI line read `Received: 35` and there is no 35px
surface anywhere — the assertion printed `optionBox.height + PX_EPSILON`, the
expression's value rather than the box's, and the live render probes at exactly 34 with
a block-only reach to 46. An error message that names a number the DOM does not contain
costs a reader one wrong hypothesis before they start. And the replacement guard is
strictly stronger than what it replaced: the old `>= 44` passed on the 44 tree AND on
the 34 tree once the reach existed, while the box equality reds on the first and the
per-axis reach read reds on the second.

Encoded as clause (5) of the spec-census rule in `dispatch-brief.mjs`.

## The route that was spelled as a regex (2026-08-29)

#3958 phase 1 deletes four ledger routes, and one of its acceptance criteria is that
`git grep` finds no reference to any of them afterwards. The lane ran the obvious census
— the four literal paths — retargeted twenty-odd doors, and reported the grep clean.

It then ran a second pattern tolerant of separators,
`(medications|nutrition|wellness)[\/]+(dose|food|practice)-history`, and found a site the
first could never have matched: `e2e/medications-followups.spec.ts:470` drove the deleted
route through a **regex literal**, `/\/medications\/dose-history/`. Backslashes between
every segment, so a grep for `/medications/dose-history` misses it however exactly the
path is spelled. That spec walked the medications door into the ledger and asserted its
kind filter, its rows and its Trends footer link — it would have gone red in CI, and the
acceptance criterion would have been reported met.

The generalisation is not about regexes. A path can be a regex literal, a template
literal split across lines, or a base plus a suffix assembled at the call site, and none
of those contain the string being searched for. So a route deletion needs two censuses:
the literal path, and a pattern tolerant of what sits between the segments. Sweep the
deleted testids and symbols too — a surviving marker is the same bug wearing a different
name, and that sweep is what confirmed the rest of the tree was clean here.

Two smaller things from the same lane are worth keeping for their shape rather than their
subject. It raised two control rows from `gap-2` to `gap-3` and wrote into two comments
that its re-homed guard had **caught** an 8px-against-10px shortfall — then re-ran the
guard with `gap-2` restored, found it passing (the hairline divider sits between the
clusters and is gapped on both sides, so the distance is two gaps plus the rule), and
rewrote both comments to say the change is agreement with the shared row rather than a
catch. A comment claiming a find it did not make is worse than no comment, and it is the
kind of claim nobody re-checks once it is in the tree.

And the census that mattered most was the one it did not trust: the issue's own inbound-
door list, written a day earlier, missed two revalidation sites and described two doors
that do not exist in the shape it claims — because most doors are built by helpers
(`doseLedgerHref` and friends) rather than written as paths, which is clause (4) of the
spec-census rule arriving from the production side.

Encoded as clause (6) of the spec-census rule in `dispatch-brief.mjs`.

## The mutation that never ran, and the one that hit a comment (2026-08-29)

Two false greens from the same lane on #3744/#3750, an hour apart, caught by the lane
itself. Both are the same failure: a mutation that does not execute is not evidence, and
neither is one that does not change the render.

The first. A `MonthCalendar` guard drove the month clamp by proving the Previous arrow
was `disabled` and then clicking it. jsdom delivers nothing to a disabled button, so the
clamp never ran — the mutation that removed it came back **green**, and the guard had
never once exercised the code it was written for. The user-reachable clamp turned out to
be a different path entirely: a value sitting outside its own field's min/max, which is
what a bound tightened around an already-saved date produces. Two cases now drive it and
the mutation is red.

The second. An `InlineError` mutation was applied with a `perl` substitution on
`role="alert"` — which matched the prose in the comment above the JSX, not the rendered
attribute. Green, for a tree whose output was byte-identical to the unmutated one.

The rule both give: **after applying a mutation, confirm the mutated line executes and
the render changes.** A mutation is a claim about behaviour, so its evidence has to be
behavioural — an assertion that fails, not a file that differs. If a mutation comes back
green, that is a finding about the test before it is a finding about the code.

A third from the same lane is the reverting half of the same problem, and is now a brief
clause: `git checkout -- <file>` means "restore this file to HEAD", not "undo my last
edit". The lane used it to revert a mutation while HEAD was its own first commit, and two
files silently rolled back past a whole issue's worth of uncommitted work. It was caught
inside one test run only because the restored tree failed the same way the mutation had —
a quieter mutation would have been reverted to a tree that no longer contained the fix,
and the green that followed would have meant nothing. Under the brief's own gate to
commit and push every ~45 minutes, HEAD is almost never where the lane started editing.
Copy the file to `$SCRATCH` with a branch-unique name before each mutation and restore
from that.

Encoded in `dispatch-brief.mjs` beside the `git stash` clause.

## The convergence that diverged, and the census that was never run (2026-08-29)

PR #4030 (#4025/#4026) reached green CI and an adversarial pass with no blocking
findings. Three of that pass's eight findings were **factual errors in the PR body, which
the orchestrator wrote**.

The load-bearing one: the body said the new `AND date <= ?` bound was inert because
"production activity dates are validated non-future." They are not. `saveActivity`
validates shape and calendar validity only, the form passes no `max` to `DateField`, and
the AI import path has the same gap. The reviewer stored a `today+3` activity in one
action-tier call and showed the bound flipping `hasPattern` true→false on a profile with
three past sessions and one planned — so a person who logs a planned session loses their
inferred cadence and the PreWorkout pseudo-slot with it. The lane had swept every
_fixture_ for a positive day shift and found none, correctly, and then generalised from
fixtures to production without running the production half. A census of the seeds is not
a census of the writers.

The second is worse in kind, because the false claim was the justification. The body said
the change "converges on the sibling's shape — `inferPracticeRhythm` has always taken
this parameter." The sibling takes an `asOf`, but uses it only for the window's _start_;
there is no upper bound, and its fallback-hour ladder reads the whole history. So after
the change the two shared-substrate siblings answer "what was inferable as of D"
**differently** — a divergence introduced under a banner that said convergence, and one
that a reader checking the claim's shape rather than its content would wave through.

The third: a partial conversion inside the function whose own comment says the pattern and
the strip "cannot disagree about a day". One line resolved its bound through the historical
zone; the next still resolved through today's, and `max` picked the later — putting back
exactly the walk the PR removed.

The generalisations. **A claim that a bound is inert is a claim about every writer, not
about the fixtures** — grep the writers and exercise one. **"It converges on X" is a
claim about X**, and has to be read in X's source, not inferred from a shared parameter
name. And a type that admits both the old and new shape — here
`ProfileDayZone = string | ((at: Date) => string)` — means the compiler cannot catch a
missed call site, so the conversion's safety rests entirely on a census; say so where the
type is defined, as this one now does.

## The issues the orchestrator filed instead of doing the work (2026-08-29)

Over one morning the orchestrator filed four issues off the back of its own lanes'
findings, labelled two of them P2, and dispatched a lane against one — while the owner's
backlog held P2s filed weeks earlier with rulings already recorded in their bodies. The
owner's words: _"why are you opening stuff like 4037 as p2 when my pre-existing p2s are
clearly more important"_, and then _"most of the issues you file are bullshit"_.

Both were right, and the second is the sharper one. Two of the four were closed
`not_planned` within the hour by the orchestrator itself on re-reading: a design question
about focus ownership across thirty components, invented from one instance, and a link on
an auth page duplicating a button's paint. Neither described anything wrong for anyone
using the app.

The dispatched one made the cost concrete. #4037 was a genuine defect — a ~40ms window in
which a keystroke is undone — but the **Direction** section the orchestrator wrote into
it was wrong in a way that would have deleted the feature: "no-op when focus is already
inside the panel" can never fire, because the host has synchronously put focus inside the
panel before the deferred frame runs. The lane found that in eleven minutes by reading the
code. The orchestrator had written the section with enough confidence to hand it to
someone as a specification, without doing so.

Three rules, in order of how much they cost to learn:

1. **A finding is not an issue.** Lanes surface things constantly; most are observations,
   and an observation written up with four questions attached is tracker noise that
   displaces real work. File when something would otherwise be lost — a stale premise
   found, or a defect a merge just introduced — and close your own noise when you see it.
2. **Self-filed work does not get the same priority slot as the owner's.** Capacity spent
   on it is capacity taken from issues the owner has already ruled on. Source lanes from
   the open backlog, oldest first, checking each for a recorded ruling.
3. **A Direction section is a specification.** Writing one without reading the code
   produces a confident instruction to do the wrong thing, and the lane that follows it
   pays for the confidence. If the direction has not been checked against the source, say
   that in the issue.

## The rule that lost to the system prompt (2026-08-30)

Two drifts kept recurring across orchestrator sessions despite being written
in the runbook since the start: reads through the `mcp__github__*` tools
instead of REST, and PRs opened as drafts instead of ready. The 2026-08-06
process-drift entry recorded one instance; the owner has since seen both
repeat in fresh sessions.

The root cause is not that orchestrators skip the runbook — it is that the
runbook was arguing against text sitting closer to the model. The Claude Code
remote harness injects a system-prompt line telling the session to use the
GitHub MCP tools "for ALL GitHub interactions", the MCP server injects its own
usage instructions, and the PR-creation path leans draft. A fresh session
imports those defaults before it reads a single repo file, and a terse
runbook rule stated once loses to guidance restated in every session's system
prompt.

Hence the fix is framing, not repetition: §GitHub access in
`docs/orchestration/environment.md` now names the harness guidance and states
that the runbook outranks it, the orchestrate skill warns that "your harness
will argue", and the ready-not-draft rule is written where the temptation
lives (banking in `dispatch.md`, candidate promotion in `review-merge.md`).
A rule that contradicts an ambient default has to name the default it
overrides, or every new session relearns the drift.

## The queue the crew filed for itself, in labels nobody defined (2026-08-30)

Two tracker drifts, measured together on the live repo. First: 11 of 96 open
issues carried "found while / found by a lane" provenance, and the
orchestrator's habit is to dispatch its own filings first — recency reads as
urgency, so the freshly-filed observation jumps issues the owner ruled on
weeks ago. The 2026-08-29 entry established the rule ("self-filed work does
not get the same priority slot as the owner's") but it lived only in this
file; the dispatch procedure never said where self-filed work goes, so each
session re-invented an answer, usually "front".

Second: the repo's live label list had grown to 52 labels against a
documented taxonomy of ~36 — 16 strays (`deps` beside `dependencies`,
`infrastructure` beside `infra`, `testing` and `test-coverage` beside `e2e`,
plus `a11y`, `coaching`, `dashboard`, `illness`, `medical`, `navigation`,
`offline`, `privacy`, `settings`, `sleep`, `tooling`, `trends`). The
mechanism is GitHub's add-labels endpoint, which silently CREATES a label it
does not recognise: one filer's synonym becomes a real label, and the
file-issue skill's own advice — "verify against the live label list if in
doubt" — then validated the stray for every later filer. A feedback loop
wearing a verification step's clothes.

Both fixes follow the tooling doctrine. The taxonomy is now CLOSED in code
(`KNOWN_LABELS` in `reconcile-tracker-core.ts`) and `checkLabelHygiene`
flags any open issue carrying a label outside it; docs and the file-issue
skill now point at the constant, never the live list. And because prose had
already told every filer not to invent labels and the strays arrived anyway,
the repo side is enforced too: `.github/workflows/label-taxonomy.yml`
deletes any off-taxonomy label the moment a filing mints it (plus a weekly
backstop), through `delete-unknown-labels.ts` — the toolchain's third writer,
confined by the same structural tests as the other two to one verb against
the repo's label collection and no issue URL at all.

Postscript, same day: before the sweep ran, the sixteen strays were checked
against actual usage and put to the owner. Three earned promotion — `testing`
(99 issues; legitimized as optional type color, where it routes nothing),
`a11y` (9 issues, type color), and `dashboard` (19 issues, a real product
surface, now a domain). The other thirteen stay deletions. A small/med/large
size axis was considered in the same ruling and DECLINED: two axes had just
measurably drifted, a third mandatory one multiplies the hygiene surface,
and the dispatch ledger already measures real lane durations — which cluster
tightly (85±5 min) because gate cost dominates issue size. Self-filed issues are
back-of-queue by rule in `dispatch.md` §Dispatch — default P3, sourced
oldest-first after owner-filed work, demonstrated P0/P1 regressions the only
exception — and the dispatch brief now forbids lanes from filing issues at
all: findings ride the return summary, and the orchestrator decides what
becomes an issue.

## The question that waited for nobody (2026-08-30)

Orchestrators had been reaching for `AskUserQuestion` mid-session — the
harness suggests it for anything ambiguous — and the owner is usually not
present while a session orchestrates, so each question parked the entire
pipeline until somebody wandered back to a prompt. The runbook already said
"never prompt the owner uninvited" about needs-human items; a blocking
question is that, plus a stalled session.

Encoded structurally, not just in prose: the orchestrate skill no longer
grants `AskUserQuestion` at all. A question becomes a `needs-human` label
with the owner assigned, or a line in the status pulse, and the session
keeps moving on other work — the needs-human skill drains the queue when
the owner actually shows up.

## The --help that ran the script (2026-08-30)

Orchestrators probe unfamiliar scripts with `--help`. Only one of the sixteen
entry scripts answered it; everywhere else the flag was silently ignored and
the DEFAULT action ran. For the dry-run scripts that wasted a network round
trip; for the stateful ones it was worse — `orchestrator-checkin.sh --help`
ran a real check-in against the flight recorder's persisted state, a state
transition the caller never asked for while trying to learn what the script
does.

The fix makes the habit harmless instead of forbidding it: every entry
script now answers `-h`/`--help` by printing its own header comment — the
documentation IS the usage, which is why the headers are written — and
exiting 0 before anything else runs (`usage.mjs` for JS/TS, an inline sed
guard in the shell scripts). `script-help.test.ts` spawns each one with the
flag, with no token and no stubs, so a guard that goes missing or drifts
below side-effectful code fails loudly.
