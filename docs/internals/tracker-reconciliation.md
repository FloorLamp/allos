# Tracker reconciliation

Status: **partial** (gather script, patcher and protocol shipped; the weekly
schedule is deliberately not wired — see "Scheduling")

The tracker is prose that quotes the code. At this repo's merge rate — 99 PRs
across 2026-08-11 and -12 alone — every path, line number, symbol and
dependency an issue body states is a fact with an expiry date that nobody
stamps. This is the loop that re-checks them.

It is **factual reconciliation only**. It never closes an issue, never edits
owner prose beyond factual status markers / cross-refs / path refreshes, and
never changes scope or a decision. Judgment calls are FLAGGED, not made.

## The pieces

| File                                              | What it is                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/orchestration/reconcile-tracker-core.ts` | Pure. Repo + tracker in as data, an evidence list out. Decides nothing.    |
| `scripts/orchestration/reconcile-tracker.ts`      | The read-only entrypoint. GitHub reads, git file list, clock, watermark.   |
| `scripts/orchestration/reconcile-patch.ts`        | Pure. Assertion-anchored patching, three kinds wide, refuses by default.   |
| `scripts/orchestration/reconcile-apply.ts`        | The one writer. Sends exactly one field, `body`.                           |
| `.claude/skills/reconcile-tracker/SKILL.md`       | The six-step protocol, the guardrails, the report format, `allowed-tools`. |
| `lib/__tests__/reconcile-tracker.test.ts`         | Parsers, false-positive floor, guardrails, capability scan.                |

```bash
npm run reconcile                        # report to stdout
npm run reconcile -- --json ev.json --out report.md
npm run reconcile -- --issue 2603,2589   # one or two issues
npm run reconcile:apply plan.json        # dry run; add --apply to write
```

The run window starts at the previous run's watermark
(`$SCRATCH/allos-reconcile-watermark.json`, else the system temp dir).
`--stamp` advances it and is **off by default**, so a dry run never moves the
mark. The report stamps both ends of its own window.

## What the deterministic half can and cannot see

This matters more than the feature list, because the failure mode is a routine
that catches the cheap class and reads as coverage. Six drift classes were
measured on this tracker on 2026-08-12:

| Class                                | Example                                                                                    | Reachable?                |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------- |
| Moved line numbers                   | #2582, #2578, #2560, #2570, #2567 quoted lines off by 2–75                                 | **yes** — anchor check    |
| Dead / unqualified paths             | a retired route still cited by name; `RecordTable.tsx` with no directory                   | **yes** — path resolution |
| Dependency on merged work            | `Depends-on: #X`, "once #X lands" where X closed                                           | **yes** — reference graph |
| Prescribed fix that cannot work      | #2567 "decline the window's first tick" — at an hourly tick that declines forever          | no                        |
| Physically impossible premise        | #2552 needed a manual sleep row to be a session; `upsertManualSample` writes `start = end` | no                        |
| Obsolete premise                     | #2377 said the biomarker→food limit direction was unmodelled; #775 shipped it              | no                        |
| False supporting claim               | #2554 said every other source-id binding uses `SOURCE`; fourteen do not                    | no                        |
| Framing that does not match the code | #2135 said "lift the state machine out of SQL"; the pure function already existed          | no                        |

Everything in the second group is a claim about BEHAVIOUR, and deciding one
needs the code read. The script's contribution there is indirect but real: it
verifies the citations, and a verified citation set is the reading list. An
issue whose every mechanical claim checks out is precisely the issue whose
prose still has to be judged.

**A routine that only caught the first group would have caught none of the six
defects found by hand that day.** Do not read a clean report as a clean tracker.

### Measured against a human pass: zero of seven

That was the prediction. It was then measured. On 2026-08-12 a read-only triage
agent audited ~40 open non-parked issues against `main` by reading code, and
found seven that were not clean:

| #    | Verdict       | What was actually wrong                                                           |
| ---- | ------------- | --------------------------------------------------------------------------------- |
| 2487 | obsolete      | shipped by #2537; `registry.ts` has no `provider` identifier left                 |
| 2110 | premise stale | the cost comment it complains about was already corrected; fan-out bounded at 12  |
| 2149 | premise stale | items 1–3 shipped; only item 5 open                                               |
| 2205 | premise stale | phases 1 and 3 shipped; only the phase-2 rename waves left                        |
| 1847 | premise stale | #2215 made five of six kinds undoable; only documents remain                      |
| 1677 | premise stale | all six rankers exist and are tested; 11 call sites still use the unranked getter |
| 2556 | fix wrong     | the "missing" write paths all exist; this is affordance wiring, not a second core |

**This script would have flagged nothing on any of the seven.**

The reason is sharper than "behavioural claims need reading", and it is the
single most useful sentence in this document. Six of the seven fail in the
INVERSE DIRECTION to everything here. Every detector in this module asks _does
the thing this issue cites still exist?_ These issues are wrong because
**something the issue says does not exist now does**. A dead-path check cannot
see a path that is alive. A moved-line check cannot see a module that was born.
The whole apparatus is pointed one way down a road that has traffic in both.

### The identified next class: inverse existence

Naming it matters, because "needs judgment" reads as unbounded and this part is
not. An inverse-existence detector is conceivable and bounded: parse the claims
an issue makes about ABSENCE — "there is no X anywhere", "X is not modelled at
all", "to build", "X does not exist yet", an unticked box whose text names a
symbol — and test each against `main` the same way a citation is tested. It
would have caught #1677 and #2556, the two most expensive on the list above.

It is deliberately not built here, and it is not free: an absence claim in a
feature issue is usually the correct description of work not yet done, which is
the same tiering problem `symbolConfidence` already handles badly enough to
warrant caution. But it is the next thing to build, and it is a bounded piece of
work rather than "add judgment".

### The two passes are complementary, not redundant

The overlap runs near zero in both directions. The human sweep verified premises
issue by issue and never systematically checked a citation; this script found
14 moved `path:line` citations of 46 testable, 9 rooted dead paths, and 17 docs
citing modules that no longer exist — none of which the sweep attempted.

That is a better result for this routine than overlap would have been. The
script does not approximate the judgment pass and is not trying to. It clears
the mechanical layer so the judgment pass starts from citations known to
resolve.

The cost ratio is the argument for running both, in that order: the human sweep
took roughly 19 minutes of agent time for 39 issues; this script takes seconds.
Cheap mechanical pass first, judgment pass on what survives it.

## Signal quality

Three decisions do most of the work of keeping the report readable, each of
them a measured false-positive class rather than a precaution:

- **A bare basename is not a dead path.** Bodies cite `RecordTable.tsx`, not
  `components/RecordTable.tsx`. A naive existence check called 46 citations
  dead where 13 were.
- **A directoried path is never collapsed to its basename.** The opposite
  error: `app/api/…/ingest/route.ts` became "ambiguous across 33 `route.ts`
  files" — less true and less useful than "does not exist".
- **A citation must be ROOTED in a real top-level directory to be a claim about
  this repo.** `hr_minutes.ts` is a SQL table, `configuration.yaml` is a Home
  Assistant file, `server/app-render/…js` is a Next internal. Unrooted dead
  citations are gathered as unverifiable, not as patch candidates.

Two more, on the anchor check: an anchor appearing on more than
`MAX_ANCHOR_OCCURRENCES` lines is DIFFUSE and pins nothing (`profile_settings`
is on sixteen lines of one module), and when an anchor appears two or three
times the correction is the NEAREST occurrence, not the first — a component
named in the import block and again 1,700 lines down must not send the reader
to the import block.

Absent SYMBOLS are tiered by the issue's labels: a `bug`'s backticked symbol is
a premise, anything else's is usually the name it PROPOSES to add. The second
is the majority and would bury the first.

## The guardrails, and why they are structural

- **Assertion-anchored patching.** A patch names the exact text it expects.
  Absent ⇒ skip and flag. Present twice ⇒ skip and flag. No fuzzy fallback. A
  drifted anchor mangling owner prose is strictly worse than doing nothing, so
  the refusal is the feature, and it is tested directly.
- **Three patch kinds, shape-checked.** `status-marker` moves between markers;
  `cross-ref` may only APPEND a bounded `(see #N)` parenthetical, so it cannot
  delete; `path-refresh` replacement must itself parse as a path. Naming the
  right kind is not enough to smuggle a rewrite through.
- **No close capability in the granted toolchain.** Not "the prompt says not
  to" — that is the same theatre as gating a Server Action in the UI only
  (#1279/#2107). The skill's `allowed-tools` grants no `issue_write`, no
  `gh issue close`, no general `Bash`; the only writer sends a payload built
  from one field. A source scan in the pure tier fails any of those appearing.

## Prevention: two conventions that shrink the problem at the source

- **`Depends-on: #123, #456`** on its own line in an issue body. Free-text
  "depends on" keeps working and is still parsed, but the structured form is
  line-anchored, unambiguous, and the one the script reports on. (As of
  2026-08-12 no open issue uses either form, which is why the dependency
  detector found nothing on its first run — it has no targets, not no bugs.)
- **The umbrella-checkbox rule**: a PR landing part of a checklist issue ticks
  its own box in the same breath. The script flags every merged "Part of #X"
  against a still-open X, so the drift is visible either way — but ticking at
  merge time is one line and removes the verification pass entirely.

## #2385: how this learns it should stop

**Working:** the flagged corpus is small, specific and actionable — each finding
carries a computed correction rather than a suspicion — and the flagged items
survive review.

**Wrong:** findings a reviewer rejects. Two shapes. A "correction" naming the
wrong place is the dangerous one, because a path refresh is inside the
guardrails and is therefore the finding most likely to be applied unexamined.
Noise is the other: an issue flagged for a symbol that was never meant to exist
yet trains the reader to skim, which costs the real findings too.

**Deceptive success, first shape: an empty report.** A healthy tracker and a
script that has silently stopped resolving anything produce the same clean
summary, and the clean one is the one nobody investigates. Nothing in the
findings can distinguish them, so the report leads with DENOMINATORS — citations
parsed, paths resolved, anchors testable, references followed, docs examined.
Zero findings across 224 citations is a healthy tracker. Zero findings across
zero citations is a broken run. A sharp drop in the examined counts between runs
is itself the finding.

**Deceptive success, second shape: an authoring habit lapsing.** This is a
DEPENDENCY, not an observation, and it is the more insidious of the two because
the denominators do not catch it. The line-citation check works only because
this tracker's authors name what is on the line, in backticks, in the same
sentence — a bare line number is unfalsifiable, and a length check finds nothing
(zero of 72 resolvable citations pointed past EOF). If that habit lapses, the
class becomes unreachable while `path citations parsed` stays high and
`line citations` stays high; only `testable against an anchor` sags, and it
sags into a clean report rather than an error. **Watch the testable-to-cited
ratio, not just the totals**; today it is 46 of 103. A run where it approaches
zero is not a tidy tracker, it is a detector that has quietly lost its grip.

## Scheduling

Run weekly, or on demand after a heavy merge day. **The cron is deliberately not
wired.** An unattended pass that writes to the tracker needs its report read at
least once per convention change, and a schedule nobody reads is how a routine
starts patching in a shape nobody sanctioned. Wire it when the report has been
boring three runs running.

## Relationship to `scripts/orchestration/`

This lives beside the dispatch, CI-watch and gate tooling because it is the same
kind of thing: process rules given teeth. It shares no code with them and reads
none of their state — the reconciliation watermark is its own file, next to but
separate from the dispatch ledger.
