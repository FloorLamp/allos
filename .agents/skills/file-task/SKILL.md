---
name: file-task
description: Investigate and draft or file a flightplan item on FloorLamp/allos when the user asks to write up, track, or file work. Verify the premise, search for duplicates and rulings, resolve consequential decisions, and prepare a concise implementation brief.
---

# File an actionable task

Use this skill when task preparation or filing is requested. A bug report or
feature discussion alone does not authorize creating tracker work.

Follow the [change and test policy](../../../docs/change-policy.md) for scope and
acceptance coverage. Missing write credentials block filing, not investigation or
a complete draft.

## Investigate

Capture the reported behavior, location, and desired result. Inspect the current
code and relevant domain contract before asking questions.

- For a bug, distinguish the reproduced symptom from the suspected mechanism.
  Cite the actual owner; label an unproven cause as unproven.
- For a feature, search existing code and neighboring surfaces before claiming
  the capability is absent. Name what exists and the specific remaining gap.
- Keep verified facts separate from assumptions. Resolve assumptions through
  code, existing rulings, or the user before presenting them as requirements.

## Check the tracker

Use the fleet flightplan skill and its CLI or MCP client. Search before filing:

```bash
node ~/ops/spaceport/flightplan/bin/flightplan.mjs list --repo FloorLamp/allos --q "<words>" --status all
```

Try several relevant terms and read near matches' notes and linked evidence.
Recheck before filing after a long investigation.

- Duplicate: report the existing item; updating it needs authorization.
- Adjacent: cross-reference the item and explain the different scope.
- Dependency: use `--blocked-by <ids>`.
- Epic: use `--parent <id>` and identify the specific remaining work.

## Resolve decisions

Batch only questions that current code and session instructions cannot settle.
Check ambiguity, placement, numbers, wrong-result cost, conflicting rulings,
coupled work, and exceptions to universal rules. These are prompts for
investigation, not seven mandatory questions.

Explain options in terms of what a person sees or can do, with a recommendation
and the impact of each choice. Use existing constants or measurements for limits.
Do not reopen a settled decision at confirmation.

If a consequential decision remains unresolved, keep it explicit in the draft.
An authorized item intended for a later owner decision uses status `needs-you`
and one concrete question. Without authorization to file that unresolved draft,
save it for review and report it as unfiled. Noninteractive work does not supply
consent.

## Draft

Use a one-clause title of at most 72 characters. Name the defect or requested
outcome; put supporting detail in the body. Keep the brief proportional to the
change rather than filling a template with redundant sections.

A feature normally needs **Problem** and **Proposal**; a bug needs **What is
wrong**, **Consequence**, and **Fix**. Add invariants or exclusions only when they
help distinguish a correct implementation. Include:

- Acceptance criteria describing observable behavior and meaningful verification.
  Prefer existing coverage; do not require new tests by default.
- Repository-rooted paths and symbols for evidence. When citing a line, name the
  code on that line so a later reader can verify it after edits.
- Related items/PRs under **Refs**, with a short reason for each reference.
- Final decisions from the discussion and any remaining owner question.

Propose reuse, simplification, or removal before a new abstraction. State what a
conversion replaces; do not prescribe a registry or scanner when types or an
existing owner can enforce the contract. If found during other work, note that
provenance briefly without appending an incident narrative.

Use truthful attribution for the actual agent/session when the host requires it.
Never copy another provider's name or fabricate a session URL.

## File and verify

Finish the reviewable package first: title, repository, notes, and any parent or
dependencies. Honor existing authorization to file; otherwise obtain approval for
that package. Incorporate requested changes before the write.

Create agent work in `backlog`; the coordinator decides readiness. Do not assign
labels or create GitHub issues. For example:

```bash
node ~/ops/spaceport/flightplan/bin/flightplan.mjs add "<title>" --repo FloorLamp/allos --kind task --status backlog --due '' --notes "<complete brief>"
```

Keep dates in notes, or pass `--due ''`, so dates in a title do not become due
dates. Add `--parent` and `--blocked-by` where applicable. Use
`--link issue:<owner>/<repo>#<n>` only to reference an existing source issue.
Preserve literal text and newlines through structured tool arguments or proper
shell quoting.

Verify the result with `flightplan.mjs show <id>` and report its item ID. If
access is blocked, leave the complete draft and say it was not filed.

If the premise already shipped or an existing ruling resolves it, report the
evidence and file nothing.
