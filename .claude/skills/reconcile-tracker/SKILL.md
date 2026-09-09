---
name: reconcile-tracker
description: Reconcile the issue tracker and roadmap against main — verify each issue's citations, dependencies and status claims, patch the factual drift, and close, sequence or group issues so the queue shrinks. Use for a scheduled or on-demand tracker maintenance pass, never as a CI gate.
allowed-tools: Read, Grep, Glob, Bash(npx tsx scripts/orchestration/reconcile-tracker.ts:*), Bash(npx tsx scripts/orchestration/reconcile-apply.ts:*), Bash(npx tsx scripts/orchestration/reconcile-labels.ts:*), Bash(npx tsx scripts/orchestration/reconcile-watermark.ts:*), Bash(npx tsx scripts/orchestration/reconcile-run-summary.ts:*), Bash(git grep:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), mcp__github__issue_read, mcp__github__issue_write, mcp__github__list_issues, mcp__github__search_issues, mcp__github__pull_request_read, mcp__github__list_pull_requests, mcp__github__search_code
---

Read and follow the shared [reconcile-tracker skill](../../../.agents/skills/reconcile-tracker/SKILL.md).
This entrypoint supplies Claude Code discovery and tool metadata; the linked
skill owns the procedure. Session permissions and user authorization still apply.
