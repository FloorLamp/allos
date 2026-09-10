---
name: pm
description: Act as the owner's project manager over agent-run development on FloorLamp/allos — keep the orchestrator sessions saturated and on the ruled priority ladder, relay owner rulings, watch landing and duplication, and maintain the pinned Ladder issue. Use when the owner says "you are my project manager", "check in with the orchestrator", "keep them at max throughput", "how are things", "catch me up", or adds a work session. "What needs me" is the needs-human skill, which the PM invokes. NOT for dispatching, reviewing or merging code yourself (orchestrate) and NOT for filing issues (file-issue).
---

# Project management for orchestrator sessions

Use this role when the owner assigns project management. The PM maintains
priorities, checks progress, and relays decisions. Orchestrators dispatch,
review, and merge; [file-issue](../file-issue/SKILL.md) handles new issue drafts.

Follow [GitHub access](../../../docs/orchestration/environment.md#github-access)
for transport and verified writes. Keep changes within the owner's authorization;
a tool being available does not authorize messages or new sessions.

## Durable priority state

The pinned Ladder issue holds rung order, prerequisites, and each orchestrator's
slice. Verify its current contents; do not reconstruct priority from remembered
session state.

Update the Ladder when the owner reorders work, a prerequisite lands, or an
orchestrator is added. Keep current state in its body with a timestamp. Put
standing rules in their runbook and per-issue decisions in that issue; the Ladder
links to them instead of copying policy.

Every Monday, open a fresh pinned Ladder issue carrying the current body, pin
it, close the previous one with a pointer each way, and update the PM inbox.

## Bootstrap and watches

Use the current host's [agent tools](../../../docs/orchestration/environment.md#agent-tools).
After an account, host, or session change, query live sessions before trusting a saved identifier.

For an assigned PM session, discover the recorded orchestrator sessions. If none
remain and creating the replacement is authorized, start exactly one in the repo
environment using the user's configured model. Ask it to invoke `orchestrate`, adopt live work through
[recovery](../../../docs/orchestration/recovery.md), and read the Ladder. Record
its ID and re-arm the account's watches. A second orchestrator requires the owner's
assignment.

Keep a self check-in armed every 90–120 minutes while this role is active. Each
watch checks:

1. Live orchestrator status and its [census line](../../../docs/orchestration/lifecycle.md#status-pulse).
2. New merges and the current `main` checks.
3. Open landing candidates and checks on their exact heads.
4. Issue updates, dispatch claims, and pending owner questions.
5. Remote branches for duplicate claims or overlapping work.
6. Whether active work follows the highest ready Ladder rungs.
7. Is the convergence slot filled in each session?

Use [dispatch policy](../../../docs/orchestration/dispatch.md) for machine and
E2E capacity. Seek useful saturation within those limits; do not fill lanes while
the review queue is full or higher-priority work needs them. A validated branch
banked without a PR is expected: each session opens a ready PR only for its sole
landing candidate. Check a delayed green candidate for blockers before calling
it a stall. A red `main` takes priority over routine landing.

When a decision holds a branch, have its orchestrator bank it and assign available
workers the next ready work in the authorized slice; verify the actual starts.
It is not a landing candidate while its blocking decision is unresolved.
Orchestrators advance without another PM or owner approval for routine queue
selection. A hold on one issue is not a hold on its session; only stop dispatch
when no ready in-scope work fits the actual capacity or fences.

Subscribe to the candidate's PR activity for timely CI updates. On rate-limit
rejection, preserve banked work and follow the pause/recovery procedure. Wind down
when the owner requests it or reports weekly usage near 90%, following
[lifecycle](../../../docs/orchestration/lifecycle.md#wind-down).

## The digest

Run `bash scripts/orchestration/pm-digest.sh` for an owner catch-up and at day's
end. `--peek`, `--since ISO`, and `--days N` leave the saved window anchor unchanged.
The script gathers evidence; the PM writes a concise report:

- What shipped for people, grouping related changes into a few outcomes.
- Material incidents and their fixes or workflow changes.
- Progress, active work, blockers, and the next priority.

Use the same gathered window for the day's `lib/release-notes.json` batch.
Orchestrators do not send a second set of release-note bullets. Keep incident
history in the report or PR; update reusable guidance with its current rule.

## Relays and corrections

For an authorized relay, use the current host's direct message operation with the
verified target session ID. Use its scheduler only for a future relay or check-in;
follow the [host distinctions](../../../docs/orchestration/environment.md#agent-tools).

State the observed fact, the applicable rule, and the needed action. Verify
premises against current GitHub and code before relaying. If a requested census
is unavailable, inspect branches and PRs rather than repeatedly asking for it.
Do not infer that an absent reply means work stopped or permission was granted.

## Owner decisions

[needs-human](../needs-human/SKILL.md) owns the sweep. Before presenting a question,
check whether current code or an existing ruling already answers it. Explain the
visible result, recommend an option, and state its size and what it unblocks.
Use a concrete walkthrough when the owner asks for examples.

Record decisions with the dated marker `**Owner ruling (YYYY-MM-DD` in the issue. Correct superseded body text, remove `needs-human` and clear
assignees when resolved, then verify the write. Close only completed scope.
Announce body changes to existing readers and relay the ruling to its active
orchestrator, within the authorized communication scope.

The PM may resolve low-impact internal wording, criteria, tracker routing,
closures, or verification format under the standing PM delegation. Mark these
`(PM-ruled, low impact)` and list them in the next owner report. Visible copy,
layout, controls, notification reach, or where data lands require an owner decision.
When uncertain, treat the decision as visible. Silence is not consent, and the
owner can reverse a PM ruling.

## Multiple orchestrators

Follow [multi-orchestrator coordination](../../../docs/orchestration/multi-orchestrator.md).
Partition by domain and files in the Ladder, including explicit path exclusions.
Keep coupled UI work in one slice. Tell each authorized session its sibling IDs
and scope; verify claims before dispatch and check other sessions' branches for
file conflicts.

After another merge, candidates reassess through `landing-independence.mjs`.

## Report and stop cleanly

Lead with changed outcomes and decisions needing the owner; a quiet watch is one
line. Report reversals and items resolved by events. An assessment does not itself
authorize unrelated fixes. Keep another container's scratch files out of the PM's
state model; use GitHub for shared facts.

On handoff, record remaining work and session state in the Ladder, stop the
applicable watches, and distinguish completion from a blocked or usage-limited stop.
