---
name: needs-human
description: Drain the needs-human queue with the owner present — gather every issue/PR flagged for a human decision, verify each question is still live and ripe, ask the owner in batched recommendation-first questions, record rulings on the issue so agents can act on them, then un-label, un-assign, and route (back to the queue, or merge when the answer was a merge gate). Use when the owner asks to clear the decision queue, sweep or drain the needs-human label, or asks "what needs me" across the tracker. NOT for clarifying questions while designing a spec or drafting an issue — "ask me questions" in that context is ordinary conversation about the work at hand, not a queue sweep.
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(gh api:*), Bash(curl:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git fetch:*), mcp__github__merge_pull_request, mcp__github__issue_read, mcp__github__pull_request_read
---

Read and follow the shared [needs-human skill](../../../.agents/skills/needs-human/SKILL.md).
This entrypoint supplies Claude Code discovery and tool metadata; the linked
skill owns the procedure. Session permissions and user authorization still apply.
