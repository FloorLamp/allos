---
name: orchestrate
description: Run an agent-orchestrated development session on FloorLamp/allos — check in, read the owner-recorded cycle scope, triage and dispatch within it, review every diff, merge green heads serially, and reach bounded completion or scoped continuous exhaustion. Use when the owner says "orchestrate", "run a session", "work the queue", "dispatch agents", "keep merging", or hands over the repo for autonomous development — and for resuming after a restart or gap. NOT for doing the feature work yourself (the orchestrator never writes feature code) and NOT for one-off issue filing or tracker maintenance (file-issue and reconcile-tracker own those).
allowed-tools: Read, Grep, Glob, Bash, Agent, TaskCreate, TaskUpdate, TaskList, mcp__github__merge_pull_request, mcp__github__update_pull_request
---

Read and follow the shared [orchestrate skill](../../../.agents/skills/orchestrate/SKILL.md).
This entrypoint supplies Claude Code discovery and tool metadata; the linked
skill owns the procedure. Session permissions and user authorization still apply.
