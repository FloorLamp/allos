---
name: file-issue
description: Interactively investigate and file a GitHub issue on FloorLamp/allos — verify the premise against the code, search the tracker for duplicates and prior rulings, pin citations to real file/lines, batch the clarifying questions, then file with every decision already baked in. Use whenever the user reports a bug, describes surprising behavior, proposes a feature, or says "file an issue", "write this up", "track this", or "add it to the backlog" — even when the idea is half-formed and needs shaping first. NOT for editing or reconciling issues that already exist (that is reconcile-tracker's job).
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(gh api:*), Bash(curl:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git fetch:*)
---

# file-issue — investigate first, decide together, file once

Issues in this repo are not notes to a future human. They are dispatch briefs:
an orchestrator clusters them and agents implement them by reading the body and
every comment (`docs/orchestration.md`, `docs/orchestration/dispatch.md`). That
sets the quality bar. A wrong premise costs a whole dispatch cluster; a vague
path costs an agent an hour of re-derivation; an undecided design question
costs a `needs-human` round-trip mid-flight. The measured failure mode is not
typos — a hand audit found 7 of ~40 open issues resting on stale or false
premises (`docs/internals/tracker-reconciliation.md`). This skill exists to
file issues that don't join that list.

Use `gh api` (GitHub REST) for **all** issue reads and writes. MCP GitHub
tools are reserved for merging PRs and are not granted here. In an environment
without the `gh` binary (some remote containers), `curl https://api.github.com/...`
covers reads — but note the unauthenticated **search** endpoint is often
rate-limited or blocked; fall back to listing issues (all open, plus the
relevant label in any state) and filtering locally. Writes always need
authenticated `gh`; without it, stop at the draft.

## 1. Capture the ask

Get the report or idea in the user's words before touching code: what happens
or is wanted, where they saw it, why it matters. Don't interrogate yet — most
questions answer themselves during investigation, and the ones that survive it
are the ones worth the user's time.

## 2. Investigate — verify every claim you're about to write

The tracker is prose that quotes the code, so every statement in the body is a
checkable claim. Check them now, while it's one grep, instead of after they've
misdirected an agent.

- **Bugs**: find the mechanism, not just the symptom. Locate the exact
  file, line, and symbol where the behavior comes from. If you can't trace
  symptom to mechanism, say so in the issue rather than guessing a cause.
- **Features**: test the absence claims. "There is no X" and "X is not
  modelled" are the claims most often wrong on this tracker (the
  inverse-existence class — something the issue says doesn't exist actually
  does). Grep for it, check `lib/`, check the obvious neighbors. A feature
  that half-exists becomes a very different, better issue.
- **Read the relevant `docs/internals/*.md`** before proposing changes to a
  shared domain model — the design and its history live there, and proposals
  that ignore a documented invariant get parked.
- Keep track of which statements you verified against code and which are
  still assumptions; assumptions either get verified, asked about in step 4,
  or labelled as open questions in the draft.

## 3. Search the tracker

Search open **and closed** issues, with more than one phrasing — the semantic
distance between how the user said it and how the tracker says it is the whole
reason duplicates slip through:

```bash
gh api -X GET search/issues -f q='repo:FloorLamp/allos is:issue <terms>' --jq '.items[] | {number, title, state}'
gh api repos/FloorLamp/allos/issues/<n>            # read a candidate body
gh api repos/FloorLamp/allos/issues/<n>/comments   # comments carry owner rulings
```

Read the near matches including comments — owner rulings live in bodies and
comment threads, and a filed issue that re-litigates a recorded ruling wastes
everyone's time. Outcomes:

- **Duplicate** → stop. Show the user the existing issue; offer to comment on
  it instead of filing.
- **Adjacent** → cross-reference with `(see #N)` in the draft, and say how the
  new issue differs so a triager doesn't have to work it out.
- **Blocked by open work** → a structured `Depends-on: #123` line on its own
  line in the body. This exact form is machine-parsed by reconciliation;
  free-text "once #123 lands" works but is second-class.
- **Part of an umbrella issue** → say "Part of #N" and name which checkbox.

## 4. Ask the clarifying questions — batched, recommendation-first

One batch, not a drip. Collect everything investigation couldn't settle and
put it to the user together, each question with the options and your
recommended default (the `needs-human` skill's posture — recommendations make
questions cheap to answer). These questions go to a person, not another
agent: when a question is technical, lead with what it means in plain terms —
what they'd see or get under each option — and keep the code-level detail
underneath. The user should be able to answer without reading the codebase.
Typical survivors of a good investigation:

- **Scope boundaries** — which surfaces are in, what is explicitly out. "Out
  of scope" lines prevent well-meaning scope creep during implementation.
- **Design calls with real alternatives** — present 2–3 options with costs,
  the way #2837 and #2830 do, and let the user pick before filing.

Priority is NOT a question: set it yourself from the calibration in step 6 and
state it in the draft. Ask only when the calibration genuinely can't settle it
— e.g. a bug that might be preempting (P0/P1) depending on facts only the user
has. Re-opening at confirm time a decision the draft already carries defeats
the point of baking decisions in.

The point of asking now is that the filed issue needs no mid-flight owner
ruling. If one specific question genuinely cannot be answered yet, the issue
carries `needs-human` and states that ONE question crisply — but treat that as
the fallback, not the plan.

If there is no user to ask (running non-interactively), do not file. Write the
complete draft plus the unresolved questions to a file and stop — filing with
unbaked decisions is the failure this skill exists to prevent.

## 5. Draft in house style

Read one exemplar before writing your first issue in a session: #2856 or
#2857 for features, #2843 or #2845 for bugs (`gh api repos/FloorLamp/allos/issues/2856`).

**Citations.** Every path rooted in a real top-level directory
(`lib/dri.ts`, never bare `dri.ts` — unrooted citations are unverifiable and
get flagged). When citing a line, name what is on it, in backticks, in the
same sentence: "`NAME_MATCHERS` in `lib/dri.ts` maps an item name to at most
one nutrient key". This habit is load-bearing: the reconciliation tooling can
only re-verify a line citation when the sentence names its anchor, and a bare
line number goes stale silently.

**Shape.** Structure with real headings and bullets — the reader is a triager
skimming for the verdict and then an agent acting on exactly what is written,
and a wall of prose serves neither. Features read as `## Problem` (with real
observed cases where possible), `## Proposal`, then `## Invariants` and
`## Out of scope` when they earn their place. Bugs read as `## What is wrong`
(the mechanism, with citations), `## Consequence` (who hits it and when), and
`## Fix` — options with a stated default when the fix is genuinely open,
rather than false confidence. Two closing elements every issue carries:

- **Acceptance criteria** — a short bulleted list of what must be true for
  the implementing agent to call this done (tests included). This is the
  contract the reviewer checks the PR against.
- **`## Refs`** — the related issues and PRs, one per line with half a line
  on why each is related. Inline `(see #N)` point-cites stay where they are;
  the Refs section is the collected map so nobody re-derives it.

**Decisions baked.** Choices made in step 4 appear as decisions ("owner
decision: extend it to the web's tight spots too"), not as open questions.
Rejected alternatives worth recording go under "Out of scope" or "Deliberately
not done" with the reason.

**Provenance.** If the issue came out of other work, open with one line saying
so ("Found while implementing #N; filed so the reasoning is not lost").

**Footer.** End the body with the attribution footer:

```
---
_Generated by [Claude Code](https://claude.ai/code)_
```

## 6. Labels

Every issue gets a **domain label** and a **priority** (`P0`–`P3`, or
`parked`); `lib` and `ui` are secondary location labels added when they help
routing. Current vocabulary (verify with
`gh api repos/FloorLamp/allos/labels --jq '.[].name'` if in doubt; never
invent a label):

> biomarkers, body-metrics, bug, ci, cleanup, db, dependencies, docs, e2e,
> enhancement, feat, findings, goals, infra, insights, intake, integrations,
> lib, medical-passport, mobile, needs-human, notifications, nutrition,
> performance, refactor, reproductive-health, security, training, ui,
> wearable, wellness

Priority calibration from the standing contract: P0/P1 bugs preempt features;
an active infrastructure bottleneck is P1; an isolated latent flake is P3.
Most well-scoped feature and cleanup work lands P2–P3.

## 7. Confirm, then file

Show the user the complete package — title, labels, full body — and get an
explicit go-ahead. Then:

```bash
gh api -X POST repos/FloorLamp/allos/issues \
  -f title='...' \
  -f body="$(cat /tmp/issue-body.md)" \
  -f 'labels[]=intake' -f 'labels[]=P2'
```

Report back the issue number and URL. If the user amends anything at the
confirm step, fold it in and show the diff of the draft, not the whole thing
again.
