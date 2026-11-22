---
name: trajectory
description: >-
  Inspect, visualize, search, compare, and export Antigravity model execution
  trajectories (/trajectory) using Trajectory Lens in Official Safe Mode: turn/step
  ledgers, parallel execution DAGs, subagent waterfalls, token & cache analytics,
  plain-language guides, and offline HTML/Markdown reports.
---

# Trajectory Lens Skill (`/trajectory`)

Use this skill when the user wants to inspect, debug, analyze, compare, or export Antigravity agent execution trajectories (e.g., `/trajectory`, "查看模型轨迹", "分析耗时和缓存", "导出轨迹报告", "对比两次会话").

## Tool Selection Guide

1. **Interactive Visualization / Dashboard (`open_trajectory_lens`)**:
   - Call `open_trajectory_lens` when the user wants to open the visual trajectory dashboard in the side pane or inspect the live timeline, DAG execution graph, subagent waterfall, token/cache pulse, or session comparison.
   - All arguments (`conversationId`, `tab`, `plainGuide`) are optional; calling with `{}` loads the latest active session.

2. **Concise Text Summary (`trajectory_summary`)**:
   - Call `trajectory_summary` when the user asks in chat for a breakdown of turns, tool usage, errors, prompt-cache hit rate, bottlenecks, or plain-language explanation without needing a full visual report.

3. **Targeted Step / Error Search (`trajectory_search`)**:
   - Call `trajectory_search` when looking for specific tool calls, file touches, error messages, keywords, or regex matches inside a session's full transcript.

4. **Offline Archival Export (`trajectory_export`)**:
   - Call `trajectory_export` with `format: "html"` (standalone interactive replay page) or `format: "markdown"` (audit report).
   - Always include the returned clickable `[filename](file:///...)` link in your reply.

## Output & Honesty Rules

- Operate strictly in **Official Safe Mode** (local transcripts + passive lifecycle hooks, no proxy).
- Be transparent about Antigravity's native trajectory boundaries if the user asks: `thinking` is the official thought summary, built-in base system prompts are not logged, and historical fork launches a new handoff conversation rather than mutating the original timeline.
