---
name: needs-human
description: Drain the needs-human queue with the owner present — gather every issue/PR flagged for a human decision, verify each question is still live and ripe, ask the owner in batched recommendation-first questions, record rulings on the issue so agents can act on them, then un-label, un-assign, and route (back to the queue, or merge when the answer was a merge gate). Use when the owner asks to clear the decision queue, sweep or drain the needs-human label, or asks "what needs me" across the tracker. NOT for clarifying questions while designing a spec or drafting an issue — "ask me questions" in that context is ordinary conversation about the work at hand, not a queue sweep.
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(gh api:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git fetch:*), mcp__github__merge_pull_request, mcp__github__issue_read, mcp__github__pull_request_read
---

# needs-human — the resolution half of the queue

`docs/orchestration.md` §Labels defines how questions ENTER the queue: an agent
states a SPECIFIC question, the orchestrator applies `needs-human` + assigns the
owner the same day. This skill is how questions LEAVE it. It runs in an
interactive session with the owner — it asks; it never decides for them.

The `reconcile-tracker` skill is the other inflow: its weekly pass FLAGS
judgment calls instead of making them, and every flag it raises is a
`needs-human` candidate. The two compose — reconcile finds and labels with the
owner absent; this skill resolves with the owner present. Neither does the
other's job.

**Hard guardrails** (the #865 posture): never close an issue · never answer a
question on the owner's behalf — an unanswered question keeps its label, because
silence is not consent · record rulings with their REASONING, verbatim in
intent · scope every supersession narrowly (a ruling about one surface does not
rewrite the doctrine that governs another) · when the owner's answer contradicts
recorded doctrine, that tension belongs IN the question's options, stated before
they answer — never discovered after.

## 1. Gather

REST first — `gh api`, never `gh issue`/`gh pr` subcommands as the primary path
(they ride GraphQL, whose rate pool exhausts independently; REST has survived
every sweep). The label endpoint returns issues AND PRs:

```bash
gh api "repos/OWNER/REPO/issues?labels=needs-human&state=open" \
  --jq '.[] | "\(.number)\t\(if .pull_request then "PR" else "issue" end)\t\(.title)"'
```

Cross-check `assignee=OWNER` — the two sets should match (the #2688 contract
pairs them); a mismatch is itself a finding to repair at the end.

**The wider sweep** (optional, and worth it when the owner asks "what needs
me?" rather than naming the label): flagged questions predating the label die in
prose. Grep open-issue bodies and the last ~2 weeks of merged-PR bodies for
`owner call|owner ruling|open question|needs a ruling|flagged for`. Anything
found that is genuinely open gets the label + assignment ON THE SPOT (that is
the orchestrator duty this skill is executing), then joins the queue below.
Discard matches whose bodies already record the ruling inline — resolved calls
stay in issue prose by convention and are not open questions.

## 2. Context — audit before asking

For each item, before any question reaches the owner:

- **Find the specific question(s).** The label contract requires them stated.
  If an item carries the label but no extractable question, that is a defect in
  the filing — derive the question from the body if it is honestly derivable,
  otherwise report the item as mislabeled rather than inventing a question.
- **Premise-audit against current main.** The question was written against a
  past tree. Verify the code it describes still exists and still behaves as
  claimed (a merge since filing may have resolved, moved, or reshaped it).
  A question whose premise died is reported as resolved-by-events, with the
  commit that did it — not asked.
- **Ripeness.** A question conditioned on unshipped work ("decide after living
  with X" where X has not shipped) is NOT askable. Post a dated note on the
  issue naming the condition and what agents should treat as the open work
  meanwhile; the label and assignment STAND (the set stays queryable), and the
  next sweep re-checks the condition instead of re-asking.
- **Stakes.** Collect what concretely hangs on the answer: which PR deferred
  which piece on it, which agent work is blocked. This goes into the question —
  the owner decides better knowing what an answer unblocks.

## 3. Ask

Batch with `AskUserQuestion`, up to 4 questions per call, multiple rounds until
the queue is drained or the owner stops. Per question:

- **Recommendation first**, labeled `(Recommended)`, with the reasoning IN the
  description — the owner is ratifying or overruling an argument, not picking a
  label.
- **Every option carries its cost.** The rejected option's genuine advantages
  are stated in its description; an option with no stated downside is not an
  option, it is an ambush.
- **Name doctrine tensions inside the question.** If an option would supersede
  a recorded ruling (#NNNN), say which and how far.
- **Present the full-scope option honestly** beside the incremental one, with
  its guardrails stated — never silently drop the ambitious shape because it
  seems too big. Deciding scale is exactly the owner's call, and this owner's
  record runs toward the fuller piece.

## 4. Record — rulings live where implementers read

An answer nobody recorded is a question that will be asked again.

- **Issue-shaped answers** go in the ISSUE BODY as a dated block —
  `**Owner ruling (YYYY-MM-DD)**` or an `## Owner rulings (date)` section —
  with the reasoning, not just the verdict. Superseded prose is struck INLINE
  (`~~old instruction~~ **struck by owner ruling, date**: what governs now and
  why), so an implementer reading the spec cannot resurrect it. This is the
  repo's convention: rulings are recorded in the body they amend, the way
  #2460/#2565/#2579 carry theirs.
- **PR-shaped answers** (a merge gate, a ratified deviation from the issue's
  spec) go as a PR COMMENT, and cross-record on the issue when the issue's spec
  is what was deviated from.
- **Scope supersessions precisely.** "Ruling X replaces #NNNN on this surface;
  #NNNN still governs Y" — one sentence of scoping prevents the next agent
  generalizing a surface ruling into doctrine.
- **Mechanics:** PATCH bodies via REST with a body file
  (`gh api repos/OWNER/REPO/issues/N -X PATCH -F body=@file.md`), and VERIFY
  the write landed by re-reading and grepping for a phrase unique to the edit —
  a transient empty-JSON response has silently dropped a PATCH before. Same
  discipline for comments (`POST .../issues/N/comments -F body=@file.md`).

## 5. Un-label, un-assign, route

Only when EVERY question on an item is resolved:

```bash
gh api -X DELETE "repos/OWNER/REPO/issues/N/labels/needs-human"
gh api -X DELETE "repos/OWNER/REPO/issues/N/assignees" -f "assignees[]=OWNER"
```

Partially answered → body updated with what was ruled, label and assignment
stay, the remaining questions enumerated so the next sweep asks only those.

Then route by what the answer was:

- **A merge gate, now satisfied** → merge. Protected-branch merges 403 over
  REST; merge goes through the MCP GitHub tool (squash), per
  `docs/orchestration.md` §REST write limits. Gate stated but not yet met
  (e.g. an e2e re-run) → leave the PR to the orchestrator with the gate
  recorded on it; do not sit polling.
- **An unblocked issue** → it returns to the ordinary queue by its existing
  priority label; removing `needs-human` + the assignment IS the return. Note
  on the issue which deferred pieces are now unblocked, so the next agent
  starts from the ruling instead of rediscovering it.
- **Not ripe** → already noted in step 2; nothing further.
- **Resolved-by-events** → record what resolved it (the commit/PR), then
  un-label and un-assign exactly as if answered.

## 6. Report

Close the session with one summary: items ruled (and which overruled a
recommendation — say so plainly), items not ripe with their re-check
conditions, items resolved by events, label-hygiene repairs made, and what is
now unblocked for agents. Unasked residue (questions found but deliberately
deferred by the owner) is listed, not dropped.
