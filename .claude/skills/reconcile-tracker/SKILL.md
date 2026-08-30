---
name: reconcile-tracker
description: Reconcile the issue tracker and roadmap against main — verify each issue's citations, dependencies and status claims, patch only the factual drift, and flag everything that needs judgment. Use for a scheduled or on-demand tracker maintenance pass, never as a CI gate.
allowed-tools: Read, Grep, Glob, Bash(npx tsx scripts/orchestration/reconcile-tracker.ts:*), Bash(npx tsx scripts/orchestration/reconcile-apply.ts:*), Bash(npx tsx scripts/orchestration/reconcile-labels.ts:*), Bash(git grep:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), mcp__github__issue_read, mcp__github__list_issues, mcp__github__search_issues, mcp__github__pull_request_read, mcp__github__list_pull_requests, mcp__github__search_code
---

# Tracker reconciliation

At this repo's velocity — dozens of agent-shipped PRs landing the same day
against a spec-dense tracker — every issue body is a set of claims about `main`
with an expiry date nobody stamps. This pass re-checks those claims. It is
**factual reconciliation only**. It fixes what is provably wrong and flags
everything else.

Two halves. The deterministic half is
`scripts/orchestration/reconcile-tracker.ts`, which gathers evidence and
decides nothing. You are the other half: you read the residue the script could
not decide, and you exercise the judgment it cannot.

## Hard guardrails

Verbatim from #865, and none of them is negotiable:

> **never closes issues · never edits owner prose beyond factual status
> markers/cross-refs/path refreshes · never changes scope or decisions —
> judgment calls get FLAGGED, not made.**

`symbol-refresh` (#3619) joined that list of factual kinds: an identifier
CITATION refreshed to the name that replaced it, on the same terms.

Three things follow, and they are enforced by construction rather than by your
compliance:

- **No close-capable tool is granted to this run.** The `allowed-tools` line
  above contains no `issue_write`, no `gh issue close`, no general REST verb.
  The body writer is `scripts/orchestration/reconcile-apply.ts`, holding
  exactly two confined writes: the body PATCH (payload built from one field,
  `body`) and a comment POST that announces a body edit on an issue with
  READERS — because a body PATCH is silent (no notification, no timeline
  event), an issue with a comment chain or an in-flight lane must get the
  edit said out loud in the thread, or its readers keep working from the
  pre-edit text. The tool posts that comment itself when the chain is
  non-empty; when the ORCHESTRATOR invokes this pass, it passes the roster's
  in-flight issue numbers as `--notify 123,456` so a quiet-but-dispatched
  issue is announced too. If you find yourself wanting a tool that could
  close an issue, the answer is to write it in the report instead.
  This is why reads here go through MCP's scoped read tools rather than REST,
  which is the transport `docs/orchestration/environment.md` §GitHub access
  otherwise mandates: `Bash(gh api:*)` would hand this run every verb including
  the ones the guardrail forbids, and a grant cannot be narrowed after the fact.
  §GitHub access names this exception, so it reads as the deliberate
  capability restriction it is rather than as drift. The rule is unchanged for
  every run that is allowed to write.
- **Every patch is assertion-anchored.** A patch names the exact text it
  expects. Absent ⇒ skip and flag. Present more than once ⇒ skip and flag.
  There is no fuzzy fallback, and you must never hand-edit a body to work
  around a refusal. A refusal means the body moved under you, which is
  precisely when a blind edit does damage.
- **Four patch kinds exist and no fifth.** `status-marker`, `cross-ref`,
  `path-refresh`, `symbol-refresh`. Anything you want to say that does not fit
  one of those four is a finding, not a patch.
- **A `symbol-refresh` is written WITH ITS BACKTICKS, on both sides** — anchor
  `` `oldName` ``, replacement `` `newName` ``. The scan reports the bare
  identifier; the patch anchors the code span, because that is what makes it a
  citation rather than a sentence. It refuses if the replacement does not
  resolve on main, if the old name still does (nothing expired), and if the
  body cites the symbol more than once — which is what holds #3472, whose
  ruling names the same absent symbol its Refs bullet does.
- **Labels have three ops and a standing exception to "flag, don't judge".**
  The second writer is `scripts/orchestration/reconcile-labels.ts`. Removing a
  `RETIRED_LABELS` entry and resetting a priority slot to the priority the
  issue's own body states are FACTS, and automatic. **Assigning a domain label
  is a judgment, and the owner has ruled (2026-08-19) that this routine makes
  it rather than flagging it — asking only when the evidence is genuinely
  split.** That narrows #865's "judgment calls get FLAGGED, not made" for this
  one axis and nothing else; every other judgment call is still flagged.
  Both endpoints it writes through are per-issue LABELS endpoints: DELETE takes
  no request body, POST takes one built from exactly one field. Neither has a
  field an issue's state could ride in.

Also, standing: **do not run the write half while another reconciliation or
triage sweep is in flight.** Duplicate or conflicting edits to a tracker are
worse than no edits. Check with the orchestrator first.

## The six-step protocol

### 1. Gather the delta

```bash
export PATH=/opt/nvm/versions/node/v24.19.0/bin:$PATH
npx tsx scripts/orchestration/reconcile-tracker.ts \
  --json /tmp/reconcile-evidence.json --out /tmp/reconcile-report.md
```

The run window starts at the previous run's watermark
(`$SCRATCH/allos-reconcile-watermark.json`, or the system temp dir), so deltas
are incremental. `--since <iso>` overrides it; `--stamp` advances it, and is
**off by default** so a dry run never moves the mark. The report stamps both
ends of its own window.

Read the report's **"What was examined"** block before its findings. Numbers
there are the only thing separating a healthy tracker from a script that has
stopped resolving anything — see step 6.

### 2. Verify PR claims, tick umbrellas

For each merged PR in the window that says "Part of #X": `git grep` the claimed
artifact on `main` **before** ticking anything. PR titles have claimed clusters
whose stragglers were legitimate exceptions. Verify, never trust a title. Note
residuals in the report.

A verified box gets a `status-marker` patch. An unverified one gets a finding.

### 3. Sweep open issues for staleness

The script does the mechanical part and hands you three lists:

- **dead paths** — a cited file that matches nothing tracked.
- **unqualified paths** — a bare basename with exactly one match; the
  correction is computed and a `path-refresh` patch is proposable.
- **moved lines** — a `file.ts:NNN` whose co-located anchor symbol now lives
  elsewhere in that file; the corrected line is computed.
- **closed dependencies** — `Depends-on: #X`, "once #X lands", "blocked by #X"
  where X is closed.

What the script explicitly **cannot** reach, and you must: a claim about
BEHAVIOUR. Measured on this tracker in one day — a prescribed fix that cannot
work at the real tick rate; a premise that is physically impossible given what
the write path stores; a premise obsoleted by work that shipped months ago; a
"every other call site does X" claim with fourteen counterexamples; a framing
that names the wrong half of the code as the gap. None of those is a
filesystem fact. Use the verified citations as your reading list: an issue
whose citations all check out is exactly the issue whose prose still has to be
read.

### 4. Refresh meta-issues

`Meta:`-titled issues carry ✅/⏳ claims and critical-path lines. Verify every
glyph against code. Flip the verified ones with `status-marker` patches; flag
the rest. (As of 2026-08-12 the tracker has none open — this step is a no-op
until one appears, which is worth reporting rather than silently skipping.)

### 4b. Label hygiene — judge it, ask only when split

Three findings, and you now settle two of them yourself.

**`retired-label` — automatic.** The writer removes it. A retired label is a
fact about the taxonomy; it routes nothing. Refused as `would-strand` when it
is the issue's only domain-ish label, because that trades wrongly-labelled for
invisible-to-clustering — those land in the domain worksheet instead.

**`priority-slot` — automatic where the body already ruled.** This tracker's
owner rulings write their verdict in prose ("**Priority dropped P2 → P3.**",
"Priority unchanged at P2"). When the label contradicts a stated priority, the
label is what drifted, and `decidePriorityLabel` resets it. It invents nothing:
a body that states no priority yields `no-stated-priority` and stays a
question. `parked` and a double-booked slot are never overruled by prose —
somebody chose those deliberately, so they come back as `slot-contested`.

**`no-domain` — you judge it.** Run the writer with no plan; it prints a
worksheet ranking what each stranded issue's own citations point at
(`scoreDomains`). Then decide:

- **One domain clearly leads** — assign it. Write a plan file and apply.
- **The evidence is split, or points nowhere tracked** — that is the ambiguous
  case. ASK the owner, with the tally in hand so the question is answerable in
  one line.
- **The work is genuinely cross-cutting** — `design` is a real domain and the
  right answer, not a shrug (`docs/orchestration/dispatch.md`).

The tally is evidence, not a verdict: it cannot know an issue citing `lib/db.ts`
is really about notifications. Read the issue before trusting it. An add may
only FILL a gap — the writer refuses `already-classified`, because re-filing
work that already has a home is an argument, not reconciliation.

Plan shape:

```json
{ "3051": [{ "label": "wellness", "reason": "protocols and pillars" }] }
```

The sweep only reads OPEN issues and the writer refuses closed ones: a closed
issue's labels are historical record, not queue state.

### 5. Docs contract check

`docs/**` `Status:` lines and README navigation versus shipped reality. The
script runs the path detector over `docs/` too. A mismatch is a **finding**; a
purely mechanical path refresh may become a tiny PR, never an unreviewed edit.

### 6. Report

One summary, in this order and no other:

```markdown
# Tracker reconciliation — <run stamp>

Window: <previous watermark> → <this run>

## What was examined ← denominators FIRST

## Patch candidates (n) ← grouped by kind, each with its computed correction

## Couldn't verify (n) ← needs a human; say what you tried

## Verified clean (n)
```

**Why denominators come first.** A report that finds little is what a healthy
tracker looks like AND what a blind script looks like, and the second one is
the one nobody investigates. "0 findings across 223 citations" is a healthy
tracker. "0 findings across 0 citations" is a broken run. If the examined
counts drop sharply between runs, treat that as the finding.

## Applying patches

```bash
npx tsx scripts/orchestration/reconcile-apply.ts plan.json           # dry run
npx tsx scripts/orchestration/reconcile-apply.ts plan.json --apply [--notify 123,456]
```

`plan.json` maps issue number → array of `AnchoredPatch`. Dry-run first,
always: the dry run re-reads every current body and reports which anchors still
hold, so you see the refusals before anything is written — and which issues
will also get the announcement comment (a non-empty comment chain, or a
number you passed via `--notify` because its dispatch is in flight).

**Never re-run a plan with `--apply` twice.** Several path refreshes contain
their own anchor inside the replacement (`intake-safety.ts` →
`lib/queries/upcoming/intake-safety.ts`), so a second pass nests them. A fresh
gather will not re-propose an applied patch, because the corrected path now
resolves — so re-gather, never replay.

**Never hand-widen an anchor to force a refusal through.** An
`anchor-ambiguous` refusal means the basename appears more than once and the
plan cannot say which; writing a longer context-bearing anchor to get past it
is exactly the fuzzy fallback the contract forbids. Flag it.

## Applying label changes

```bash
npx tsx scripts/orchestration/reconcile-labels.ts                    # dry run + worksheet
npx tsx scripts/orchestration/reconcile-labels.ts --apply            # removals + priority
npx tsx scripts/orchestration/reconcile-labels.ts --plan p.json --apply   # + your domain calls
```

It builds the removal and priority work itself from the live tracker, takes
domain adds only from `--plan`, re-reads each issue immediately before writing,
and prints one line per write with its refusal reason. Same discipline as the
applier: dry run first, and never while another sweep is in flight.

## Scheduling

Run weekly, or on demand after a heavy merge day. The schedule is deliberately
**not** wired to a cron in this repo: an unattended pass that writes to the
tracker needs its report reviewed at least once per convention change, and a
cron that nobody reads is how a routine starts patching in a shape nobody
sanctioned. Wire it when the report has been boring three runs running.
