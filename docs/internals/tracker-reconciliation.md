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

**Deceptive success: an empty report.** A healthy tracker and a script that has
silently stopped resolving anything produce the same clean summary, and the
clean one is the one nobody investigates. Nothing in the findings can
distinguish them, so the report leads with DENOMINATORS — citations parsed,
paths resolved, anchors testable, references followed, docs examined. Zero
findings across 224 citations is a healthy tracker. Zero findings across zero
citations is a broken run. A sharp drop in the examined counts between runs is
itself the finding.

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
