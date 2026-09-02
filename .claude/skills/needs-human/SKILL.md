---
name: needs-human
description: Drain the needs-human queue with the owner present — gather every issue/PR flagged for a human decision, verify each question is still live and ripe, ask the owner in batched recommendation-first questions, record rulings on the issue so agents can act on them, then un-label, un-assign, and route (back to the queue, or merge when the answer was a merge gate). Use when the owner asks to clear the decision queue, sweep or drain the needs-human label, or asks "what needs me" across the tracker. NOT for clarifying questions while designing a spec or drafting an issue — "ask me questions" in that context is ordinary conversation about the work at hand, not a queue sweep.
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(gh api:*), Bash(curl:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git fetch:*), mcp__github__merge_pull_request, mcp__github__issue_read, mcp__github__pull_request_read
---

# needs-human — the resolution half of the queue

`docs/work/labels.md` defines how questions ENTER the queue: an
agent states a SPECIFIC question; the worker labels + assigns same-day.

This skill is how questions LEAVE it — an interactive session with the
owner. It asks; it never decides for them.

`reconcile-tracker` is the other inflow: its pass FLAGS judgment calls, and
every flag is a candidate here. Reconcile finds with the owner absent; this
skill resolves with the owner present. Neither does the other's job.

**Hard guardrails** (the #865 posture): never close an issue · never answer on
the owner's behalf (silence is not consent; an unanswered question keeps its
label) · record rulings with their REASONING · scope supersessions narrowly.

When the owner's answer would contradict recorded doctrine, that tension
belongs IN the question's options, stated before they answer — never
discovered after.

## 0. Transport

**`docs/work/environment.md` §GitHub access governs, in full**: REST
outside the MCP set, reads unauthenticated, writes on the token variables, PATCH
where a sandbox refuses DELETE, no write believed until re-read.

- **`command -v gh` once, at the start** — `gh` is absent in Claude Code
  remote sessions, the session type that most often owns this queue.
- **An unset token does not cancel the sweep.** Steps 1–3 are reads; only
  step 4 stops, saying plainly it can record nothing and handing the owner
  the drafted rulings. Quitting at step 0 over an unneeded credential throws
  away the whole conversation.

## 1. Gather

The label endpoint returns issues AND PRs:

```bash
gh api "repos/OWNER/REPO/issues?labels=needs-human&state=open" \
  --jq '.[] | "\(.number)\t\(if .pull_request then "PR" else "issue" end)\t\(.title)"'
```

Cross-check `assignee=OWNER` — the sets should match (#2688 pairs them); a
mismatch is itself a finding to repair at the end.

**The wider sweep**, when the owner asks "what needs me?": flagged questions
predating the label die in prose. Grep open issues and ~2 weeks of merged PRs
for `owner call|owner ruling|open question|needs a ruling|flagged for`.

Anything genuinely open gets the label + assignment ON THE SPOT, then joins
the queue. Discard matches whose bodies already record the ruling inline.

## 2. Context — audit before asking

For each item, before any question reaches the owner:

- **Read the WHOLE body and EVERY comment, freshly, now** — never a slice or
  a cached read. Rulings append to body ENDS and questions arrive as
  comments, so truncation drops the most binding text; a live run missed a
  same-morning ruling and asked a question contradicting it.
- Re-read immediately before ASKING, not once at sweep start — a ruling can
  land mid-sweep.
- **Find the specific question(s).** The label contract requires them
  stated. No extractable question is a filing defect: derive it honestly or
  report the item mislabeled — never invent one. The comment thread is part
  of the question set, not context around it.
- **Premise-audit against current main.** The question was written against a
  past tree; a merge may have resolved or reshaped it. A dead premise is
  reported resolved-by-events with the commit — not asked.
- **Ripeness.** A question conditioned on unshipped work is NOT askable.
  Post a dated note naming the condition; label and assignment STAND, and
  the next sweep re-checks the condition instead of re-asking.
- **Stakes.** Collect what hangs on the answer — which PR deferred what,
  which agent work is blocked. The owner decides better knowing what an
  answer unblocks.

## 3. Ask

Batch with `AskUserQuestion`, up to 4 per call, rounds until drained or the
owner stops. Per question:

- **Say what it does to the person using the app, in plain English, FIRST** —
  not the module or doctrine, but what someone trying to do something
  notices. The mechanism is self-evident only to whoever just read the code,
  which is exactly why they are the wrong judge of it.
- Write that paragraph before the options every time. If a question truly
  has no user-visible consequence, say so there and state what it costs
  instead (agent time, a guard's reach). Symbol names come AFTER, for the
  implementer who reads the ruling later.
- **Recommendation first**, labeled `(Recommended)`, reasoning IN the
  description — the owner ratifies or overrules an argument, not a label.
- **Every option carries its cost.** An option with no stated downside is
  not an option, it is an ambush.
- **Name doctrine tensions inside the question** — if an option supersedes a
  recorded ruling (#NNNN), say which and how far.
- **Present the full-scope option honestly** beside the incremental one —
  deciding scale is exactly the owner's call, and this owner's record runs
  toward the fuller piece.

## 4. Record — rulings live where implementers read

An answer nobody recorded is a question that will be asked again.

- **Issue-shaped answers** go in the ISSUE BODY as a dated block
  (`**Owner ruling (YYYY-MM-DD)**`) with the reasoning. Superseded prose is
  struck INLINE (`~~old~~ **struck by owner ruling, date**: what governs
now`), the way #2460/#2565/#2579 carry theirs.
- **PR-shaped answers** (a merge gate, a ratified deviation) go as a PR
  COMMENT, cross-recorded on the issue when its spec was deviated from.
- **Scope supersessions precisely** — "X replaces #NNNN on this surface;
  #NNNN still governs Y" — so the next agent cannot generalize a surface
  ruling into doctrine.
- **An answer outside the offered options is still a ruling.** Record it
  rather than re-asking — but CHECK IT AGAINST PINNED CONSTRAINTS first, so
  the recorded ruling is not an impossible spec (a free-text dot-size ruling
  once had to name the radius-ladder test and its headroom).
- **The owner may REVISE an earlier ruling**, including that morning's.
  Record a dated AMENDMENT narrowing the original inline — never rewrite or
  delete it; the original reasoning still carries the surviving part.
- State what the amendment now permits and what stays declined in the same
  breath, then cross-record on any issue filed in tension with the original.
- **Mechanics:** PATCH bodies via REST with a body file
  (`gh api repos/OWNER/REPO/issues/N -X PATCH -F body=@file.md`); comments
  via `POST .../issues/N/comments`. Re-read to verify — a ruling that
  silently failed to write is an answer the tracker never heard.

## 5. Un-label, un-assign, route

Only when EVERY question on an item is resolved:

```bash
gh api -X DELETE "repos/OWNER/REPO/issues/N/labels/needs-human"
gh api -X DELETE "repos/OWNER/REPO/issues/N/assignees" -f "assignees[]=OWNER"
```

When a sandbox refuses `DELETE` (§GitHub access), do both in one PATCH — it
sets the arrays wholesale, so `needs-human` is gone by omission:

```bash
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -d '{"labels":["ui","P3"],"assignees":[]}' \
  "https://api.github.com/repos/OWNER/REPO/issues/N"
```

**VERIFY BY RE-READING THE ITEM, NEVER THE LIST.** The label-filtered list
serves stale after a successful delete — three removals once returned `200`
and the list still showed all three. `GET issues/N` per item.

Partially answered → body updated with what was ruled; label and assignment
stay; remaining questions enumerated so the next sweep asks only those.

Then route by what the answer was:

- **A merge gate, now satisfied** → merge (protected-branch merges 403 over
  REST — an MCP-only write, §GitHub access). Gate stated but unmet → leave
  the PR to the worker with the gate recorded; do not sit polling.
- **An unblocked issue** → returns to the ordinary queue by its existing
  priority label; removing `needs-human` + the assignment IS the return.
  Note which deferred pieces are now unblocked.
- **Check it HAS a priority label first.** A question-shaped issue often
  carries `needs-human` and nothing else; dropping the label then removes it
  from every queue. Give it domain + priority in the same PATCH.
- Note what the ruling unblocks ELSEWHERE — a settled convention frees the
  doc or follow-up waiting on it, and its owner cannot know unless you say
  so on it.
- **Not ripe** → already noted in step 2; nothing further.
- **Resolved-by-events** → record what resolved it (commit/PR), then
  un-label and un-assign exactly as if answered.

## 6. Report

One closing summary: items ruled (saying which overruled a recommendation),
items not ripe with re-check conditions, items resolved by events, hygiene
repairs, and what is now unblocked.

Unasked residue — questions found but deferred by the owner — is listed,
not dropped.
