---
name: pm
description: Act as the owner's project manager over agent-run development on FloorLamp/allos — keep the orchestrator sessions saturated and on the ruled priority ladder, relay owner rulings, watch landing and duplication, and maintain the pinned Ladder issue. Use when the owner says "you are my project manager", "check in with the orchestrator", "keep them at max throughput", "how are things", "catch me up", or adds a work session. "What needs me" is the needs-human skill, which the PM invokes. NOT for dispatching, reviewing or merging code yourself (orchestrate) and NOT for filing issues (file-issue).
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(curl:*), Bash(jq:*), Bash(git fetch:*), Bash(git log:*), Bash(git show:*), Bash(git grep:*), Bash(git diff:*), Bash(git ls-remote:*), Bash(date:*), mcp__Claude_Code_Remote__get_session, mcp__Claude_Code_Remote__list_sessions, mcp__Claude_Code_Remote__create_session, mcp__Claude_Code_Remote__create_trigger, mcp__Claude_Code_Remote__update_trigger, mcp__Claude_Code_Remote__delete_trigger, mcp__Claude_Code_Remote__list_triggers, mcp__Claude_Code_Remote__send_later, mcp__Claude_Code_Remote__subscribe_pr_activity, mcp__Claude_Code_Remote__unsubscribe_pr_activity, SendMessage, ListAgents
---

Read and follow the shared [pm skill](../../../.agents/skills/pm/SKILL.md).
This entrypoint supplies Claude Code discovery and tool metadata; the linked
skill owns the procedure. Session permissions and user authorization still apply.
