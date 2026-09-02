---
name: reconcile-tracker
description: Reconcile the issue tracker and roadmap against main — verify each issue's citations, dependencies and status claims, patch only the factual drift, and flag everything that needs judgment. Use for a scheduled or on-demand tracker maintenance pass, never as a CI gate.
allowed-tools: Read, Grep, Glob, Bash(npx tsx scripts/work/reconcile-tracker.ts:*), Bash(npx tsx scripts/work/reconcile-apply.ts:*), Bash(npx tsx scripts/work/reconcile-labels.ts:*), Bash(npx tsx scripts/work/reconcile-watermark.ts:*), Bash(git grep:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), mcp__github__issue_read, mcp__github__list_issues, mcp__github__search_issues, mcp__github__pull_request_read, mcp__github__list_pull_requests, mcp__github__search_code
---

# Tracker reconciliation

At this repo's velocity, every issue body is a set of claims about `main`
with an expiry date nobody stamps. This pass re-checks those claims — it is
**factual reconciliation only**: fix what is provably wrong, flag the rest.

Two halves. `scripts/work/reconcile-tracker.ts` gathers evidence and
decides nothing; you read the residue the script could not decide and
exercise the judgment it cannot.

## Hard guardrails

Verbatim from #865, and none of them is negotiable:

> **never closes issues · never edits owner prose beyond factual status
> markers/cross-refs/path refreshes · never changes scope or decisions —
> judgment calls get FLAGGED, not made.**
> `symbol-refresh` (#3619) joined that list of factual kinds: an identifier
> CITATION refreshed to the name that replaced it, on the same terms.

These are enforced by construction rather than by your compliance:

- **No close-capable tool is granted to this run.** The `allowed-tools` line
  has no `issue_write`, no `gh issue close`, no general REST verb. Wanting a
  tool that could close an issue means the answer belongs in the report.
- The body writer, `reconcile-apply.ts`, holds exactly two confined writes:
  a body PATCH (payload built from one field, `body`) and a comment POST
  that announces a body edit on an issue with READERS — a body PATCH is
  silent, and a comment chain or in-flight lane keeps the pre-edit text.
- The tool comments itself when the chain is non-empty; an WORKER
  invoking this pass adds `--notify 123,456` with the roster's in-flight
  issues so a quiet-but-dispatched issue is announced too.
- Reads go through MCP's scoped read tools rather than REST, the deliberate
  exception §GitHub access names: `Bash(gh api:*)` would hand this run every
  verb, and a grant cannot be narrowed after the fact. The REST rule is
  unchanged for every run that is allowed to write.
- **Every patch is assertion-anchored** — it names the exact text it expects.
  Absent ⇒ skip and flag; present twice ⇒ skip and flag. No fuzzy fallback,
  and never hand-edit a body around a refusal: a refusal means the body
  moved under you, which is precisely when a blind edit does damage.
- **Four patch kinds exist and no fifth.** `status-marker`, `cross-ref`,
  `path-refresh`, `symbol-refresh`. Anything else is a finding, not a patch.
- **A `symbol-refresh` is written WITH ITS BACKTICKS on both sides** — anchor
  `` `oldName` ``, replacement `` `newName` `` — anchoring the code span, not
  the sentence. It refuses when the replacement does not resolve on main,
  when the old name still does, or when the body cites the symbol twice.
- **Labels have three ops** (`reconcile-labels.ts`): removing a retired
  label and resetting a priority slot to the body's own stated ruling are
  FACTS, automatic. Both endpoints are per-issue LABELS endpoints with no
  field an issue's state could ride in.
- **Assigning a domain label is a judgment the owner ruled this routine
  makes** (2026-08-19), asking only when the evidence is genuinely split.
  That narrows "judgment calls get FLAGGED, not made" for this one axis and
  nothing else.

Also, standing: **do not run the write half while another reconciliation or
triage sweep is in flight** — duplicate edits are worse than none. Check with
the worker first.

## The six-step protocol

### 1. Gather the delta

```bash
# .nvmrc-major node on PATH — discovered, never a pinned path (environment.md)
export PATH=$(node scripts/work/host.mjs node-bin):$PATH
npx tsx scripts/work/reconcile-tracker.ts \
  --json /tmp/reconcile-evidence.json --out /tmp/reconcile-report.md
```

The window starts at the previous run's watermark, stored IN the tracker (the
issue titled "Reconcile watermark (machine state)") so a recycled container
cannot lose it. `--since <iso>` overrides; the gatherer only ever reads it.

Read the report's **"What was examined"** block before its findings — the
numbers there are the only thing separating a healthy tracker from a script
that has stopped resolving anything (step 6).

### 2. Verify PR claims, tick umbrellas

For each merged PR in the window claiming "Part of #X": `git grep` the
claimed artifact on `main` BEFORE ticking anything — titles have claimed
clusters whose stragglers were legitimate exceptions. Verify, never trust.

A verified box gets a `status-marker` patch. An unverified one gets a finding.

### 3. Sweep open issues for staleness

The script does the mechanical part and hands you the lists:

- **dead paths** — a cited file that matches nothing tracked.
- **unqualified paths** — a bare basename with exactly one match; the
  correction is computed and a `path-refresh` patch is proposable.
- **moved lines** — a `file.ts:NNN` whose co-located anchor symbol now lives
  elsewhere in the file; the corrected line is computed.
- **closed dependencies** — `Depends-on: #X` and its free-text forms where X
  is closed.

What the script CANNOT reach, and you must: claims about BEHAVIOUR — a
prescribed fix that cannot work, an impossible premise, a framing naming the
wrong half of the code (all measured on this tracker in one day).

Use the verified citations as your reading list: an issue whose citations all
check out is exactly the issue whose prose still has to be read.

### 4. Refresh meta-issues

`Meta:`-titled issues carry ✅/⏳ claims and critical-path lines. Verify every
glyph against code; flip the verified ones with `status-marker` patches, flag
the rest. None are open as of 2026-08-12 — report the no-op, don't skip it.

### 4b. Label hygiene — judge it, ask only when split

Three findings; you settle two of them yourself.

**`retired-label` — automatic.** The writer removes it; a retired label
routes nothing. Refused as `would-strand` when it is the issue's only
domain-ish label — those land in the domain worksheet instead.

**`priority-slot` — automatic where the body already ruled.** Owner rulings
write their verdict in prose ("**Priority dropped P2 → P3.**"); a label
contradicting a stated priority is what drifted, and the writer resets it.

A body stating no priority stays a question; `parked` and double-booked
slots come back `slot-contested`.

**`no-domain` — you judge it.** Run the writer with no plan for the
worksheet (`scoreDomains` ranks what each stranded issue's citations point
at), then decide:

- **One domain clearly leads** — assign it: plan file, then apply.
- **Split or pointing nowhere tracked** — ASK the owner, tally in hand, so
  the question is answerable in one line.
- **Genuinely cross-cutting** — `design` is a real domain and the right
  answer, not a shrug (`docs/work/labels.md`).

The tally is evidence, not a verdict — it cannot know an issue citing
`lib/db.ts` is really about notifications; read the issue first. An add may
only FILL a gap: the writer refuses `already-classified`.

The sweep reads OPEN issues only and the writer refuses closed ones: a
closed issue's labels are historical record, not queue state.

Plan shape:

```json
{ "3051": [{ "label": "wellness", "reason": "protocols and pillars" }] }
```

### 5. Docs contract check

`docs/**` `Status:` lines and README navigation versus shipped reality; the
script runs the path detector over `docs/` too.

A mismatch is a **finding**; a purely mechanical path refresh may become a
tiny PR, never an unreviewed edit.

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

**Why denominators come first.** "0 findings across 223 citations" is a
healthy tracker; "0 findings across 0 citations" is a broken run — and the
clean-looking one is the one nobody investigates.

A sharp drop in examined counts between runs IS the finding.

## Applying patches

```bash
npx tsx scripts/work/reconcile-apply.ts plan.json           # dry run
npx tsx scripts/work/reconcile-apply.ts plan.json --apply [--notify 123,456]
```

`plan.json` maps issue number → array of `AnchoredPatch`. Dry-run first,
always: it re-reads every current body and reports which anchors still hold.

It also lists which issues will get the announcement comment (a non-empty
chain, or `--notify` because the dispatch is in flight).

**Never re-run a plan with `--apply` twice.** Several path refreshes contain
their own anchor inside the replacement, so a second pass nests them. A
fresh gather will not re-propose an applied patch — re-gather, never replay.

**Never hand-widen an anchor to force a refusal through.** An
`anchor-ambiguous` refusal means the plan cannot say which occurrence;
writing a longer anchor past it is the forbidden fuzzy fallback. Flag it.

## Applying label changes

```bash
npx tsx scripts/work/reconcile-labels.ts                    # dry run + worksheet
npx tsx scripts/work/reconcile-labels.ts --apply            # removals + priority
npx tsx scripts/work/reconcile-labels.ts --plan p.json --apply   # + your domain calls
```

It builds removal and priority work from the live tracker, takes domain adds
only from `--plan`, re-reads each issue immediately before writing, and
prints one line per write. Dry run first; never while another sweep runs.

## Stamp the watermark — only after the report is read

```bash
npx tsx scripts/work/reconcile-watermark.ts stamp \
  --evidence /tmp/reconcile-evidence.json --apply   # dry run without --apply
```

Stamps the GATHER's own timestamp — nothing between gather and stamp escapes
the next window. Refuses rewinds; the first apply creates the carrier issue.

## Scheduling

Run weekly, or on demand after a heavy merge day. Deliberately NOT wired to
a cron: an unattended pass that writes to the tracker needs its report read.

An unread cron is how a routine starts patching in a shape nobody
sanctioned. Wire it when the report has been boring three runs running.
