---
name: file-issue
description: Interactively investigate and file a GitHub issue on FloorLamp/allos — verify the premise against the code, search the tracker for duplicates and prior rulings, pin citations to real file/lines, batch the clarifying questions, then file with every decision already baked in. Use whenever the user reports a bug, describes surprising behavior, proposes a feature, or says "file an issue", "write this up", "track this", or "add it to the backlog" — even when the idea is half-formed and needs shaping first. NOT for editing or reconciling issues that already exist (that is reconcile-tracker's job).
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(gh api:*), Bash(curl:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git fetch:*)
---

# file-issue — investigate first, decide together, file once

Issues here are dispatch briefs, not notes to a future human: an
orchestrator clusters them and agents implement them by reading the body and
every comment (`docs/orchestration.md`).

That sets the bar — a wrong premise costs a whole dispatch cluster; an
undecided design question costs a mid-flight round-trip.

The measured failure mode is not typos: a hand audit found 7 of ~40 open
issues on stale premises (`docs/internals/tracker-reconciliation.md`). This
skill files issues that don't join that list.

**`docs/orchestration/environment.md` §GitHub access governs transport** —
REST throughout, `gh api` or plain `curl`, reads unauthenticated, writes on
`${GH_TOKEN:-$GITHUB_TOKEN}`, no write believed until re-read. No MCP here.

Two consequences that shape the steps:

- **The search endpoint is the one path you cannot count on** (§GitHub
  access says why). Step 3 lists and filters locally, so a blocked search
  degrades speed, never coverage.
- **A missing token stops filing, not investigating.** Only step 7 needs the
  credential. Without one, finish the draft, show the owner the complete
  package, and say it is unfiled — never abandon the investigation at step 0
  over a write you have not reached.

## 1. Capture the ask

Get the report in the user's words before touching code: what happens or is
wanted, where they saw it, why it matters. Don't interrogate yet — most
questions answer themselves during investigation.

## 2. Investigate — verify every claim you're about to write

The tracker is prose that quotes the code, so every statement in the body is
a checkable claim. Check them now, while it's one grep, instead of after
they've misdirected an agent.

- **Bugs**: find the mechanism, not just the symptom — the exact file, line,
  and symbol. If you can't trace symptom to mechanism, say so in the issue
  rather than guessing a cause.
- **Features**: test the absence claims. "There is no X" is the claim most
  often wrong on this tracker (the inverse-existence class). Grep for it,
  check `lib/` and the neighbors; a feature that half-exists becomes a very
  different, better issue.
- **Read the relevant `docs/internals/*.md`** before proposing changes to a
  shared domain model — proposals that ignore a documented invariant get
  parked.
- Track which statements you verified and which are assumptions; assumptions
  get verified, asked in step 4, or labelled open questions in the draft.

## 3. Search the tracker

Search open **and closed** issues, with more than one phrasing — the
semantic distance between the user's words and the tracker's is the whole
reason duplicates slip through:

```bash
# The dependable path: list, then filter locally (§GitHub access).
gh api 'repos/FloorLamp/allos/issues?state=all&labels=<domain>&per_page=100'
# Search when it is available — faster, but never the only method you try.
gh api -X GET search/issues -f q='repo:FloorLamp/allos is:issue <terms>' --jq '.items[] | {number, title, state}'
gh api repos/FloorLamp/allos/issues/<n>            # read a candidate body
gh api repos/FloorLamp/allos/issues/<n>/comments   # comments carry owner rulings
```

**Read every near match WHOLE — entire body, every comment, never a slice.**
Rulings append to body ENDS and questions arrive as comments; a live run's
truncated read filed exactly what a same-day ruling had struck.

Re-read at draft time too, if the investigation was long — a ruling can land
while you work. Outcomes:

- **Duplicate** → stop. Show the user the existing issue; offer to comment
  on it instead of filing.
- **Adjacent** → cross-reference with `(see #N)` and say how the new issue
  differs, so a triager doesn't have to work it out.
- **Blocked by open work** → a structured `Depends-on: #123` line on its own
  line (machine-parsed; free-text "once #123 lands" is second-class).
- **Part of an umbrella issue** → say "Part of #N" and name which checkbox.

## 4. Ask the clarifying questions — batched, recommendation-first

One batch, not a drip: everything investigation couldn't settle, each
question with options and your recommended default (the needs-human
posture — recommendations make questions cheap to answer).

These questions go to a person: lead with what each option means in plain
terms — what they'd see or get — with code-level detail underneath,
answerable without reading the codebase.

`docs/orchestration/decision-classes.md` names the seven classes owners got
mid-flight in one day: two readings, placement, a number, wrong-result cost,
two rulings on one name, coupled issues, edges of an "every X" rule. Ask each.

Priority is NOT a question: set it from the calibration in step 6 and state
it in the draft. Ask only when the calibration genuinely can't settle it.
Re-opening a drafted decision at confirm time defeats baking decisions in.

The point of asking now is that the filed issue needs no mid-flight owner
ruling. When one question genuinely can't be answered yet, the issue carries
`needs-human` and states that ONE question crisply — fallback, not plan.

If there is no user to ask (running non-interactively), do not file: write
the draft plus the unresolved questions to a file and stop. Filing with
unbaked decisions is the failure this skill exists to prevent.

## 5. Draft in house style

Read one exemplar first: #2856/#2857 for features, #2843/#2845 for bugs.

**Title.** One clause, 72 characters max, no colon or dash tail; detail is the
body's first line. A bug names the defect ("HRV drops silently since Aug 29");
a feature names the outcome ("Button is the only button"). Rule: #4983.

**Citations.** Every path rooted in a real top-level directory
(`lib/dri.ts`, never bare `dri.ts`). When citing a line, name what is ON it,
in backticks, in the same sentence.

Reconciliation can only re-verify a line citation whose sentence names its
anchor; a bare number goes stale silently.

**Shape.** Real headings and bullets — the reader is a triager skimming for
the verdict, then an agent acting on exactly what is written. Features:

`## Problem`, `## Proposal`, then `## Invariants` / `## Out of scope` when
earned. Bugs: `## What is wrong` (mechanism, cited), `## Consequence`,
`## Fix` (options with a stated default when genuinely open).

Two closing elements every issue carries:

- **Acceptance criteria** — the bulleted contract (tests included) the
  reviewer checks the PR against.
- **`## Refs`** — related issues/PRs, one per line with half a line on why.
  Inline `(see #N)` stays put; Refs is the collected map.

**Decisions baked.** Step-4 choices appear as decisions, not open questions.
Rejected alternatives worth recording go under "Out of scope" with reasons.

**Simplest shape (owner, 2026-08-31).** Propose to simplify, extract, unify —
say what the change DELETES or straightens. Enforce invariants with TYPES over
guards/registries; a layer-adding proposal states why less code can't, or waits.

**Provenance.** If the issue came out of other work, open with one line:
"Found while implementing #N; filed so the reasoning is not lost."

**Footer.** End the body with the attribution footer:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

## 6. Labels

Every issue gets **at least one domain label** and **exactly one
priority-slot label** (`P0`–`P3` or `parked`, never two); cross-cutting
design/UX work takes `design`.

`bug` is the one type label dispatch reads; `feat`/`refactor`/`testing`/
`a11y` are optional color, and `ui` hints e2e-heavy work.

The taxonomy is CLOSED — verify against `KNOWN_LABELS` in
`reconcile-tracker-core.ts`, never the live label list: the add-labels endpoint
silently mints unknown labels, validating the next mistake.

Never invent a label — a missing concept is an owner decision — and never
apply a retired one (`docs/orchestration/labels.md`):

> a11y, biomarkers, body-metrics, bug, ci, dashboard, db, dependencies,
> design, docs, e2e, feat, findings, goals, infra, insights, intake,
> integrations, medical-passport, mobile, needs-human, notifications,
> nutrition, performance, refactor, reproductive-health, security, testing,
> training, ui, wearable, wellness

Priority calibration: P0/P1 bugs preempt features; an active infrastructure
bottleneck is P1; an isolated latent flake is P3; most well-scoped feature
and cleanup work lands P2–P3.

An issue whose provenance is other agent work ("Found while implementing
#N") defaults to P3 regardless of how it reads — self-filed work never gets
the owner's slot.

A P0/P1 claim on one needs the regression demonstrated in the body
(`docs/orchestration/dispatch.md` §Dispatch).

## 7. Confirm, then file

Show the user the complete package — title, labels, full body — and get an
explicit go-ahead. Then:

```bash
gh api -X POST repos/FloorLamp/allos/issues \
  -f title='...' \
  -f body="$(cat /tmp/issue-body.md)" \
  -f 'labels[]=intake' -f 'labels[]=P2'
```

Report back the number and URL from the POST's own response — no verifying
read for a create (§GitHub access's re-read rule is about edits). If the
user amends anything at confirm, fold it in and show the diff of the draft.

If the investigation ended in a ruling rather than an issue — the premise
already shipped, or a recorded ruling covers it — say so and file nothing. A
correct "this exists, here is where" is the skill working, not failing.
