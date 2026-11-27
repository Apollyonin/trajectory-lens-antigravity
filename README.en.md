# Trajectory Lens (`trajectory-lens`)

> **Notice**: This project is an **AI-assisted plugin** developed for **Google Antigravity**, re-implemented from **DSH's official model execution trajectory visualizer features**. It runs in **Official Safe Mode (zero proxy)** and is not an official DSH or Google product.

---

## Core Features (Re-implemented with DSH Parity)

- **Turn / Step Ledger & Timeline**: Hierarchical turn view pairing `PLANNER_RESPONSE` reasoning summaries, parallel tool calls, `GENERIC` tool outputs, `SYSTEM_MESSAGE`, `CHECKPOINT` compaction markers, and `ERROR_MESSAGE` events, with live auto-follow and `1x / 5x / 20x` replay scrubbing.
- **Execution Graph (DAG)**: Interactive SVG directed acyclic graph supporting `LR` / `TB` layouts, parallel tool fan-out & convergence edges, category/turn filtering, pan & zoom, and click-to-inspect details.
- **Multi-Agent Subagent Waterfall**: Recursively links `invoke_subagent` spawns and `send_message` callbacks across `~/.gemini/antigravity/brain/<childId>/` into a span tree & wall-clock waterfall with one-click drill-down.
- **Tokens, Prompt Cache & Latency Analytics**: Dual-axis context growth & prompt-cache hit-rate charts, compaction markers, tool category mix, Top-10 slowest calls, workspace touched files, and automated pattern insights (retry loops, cache drops, latency outliers).
- **Session Compare**: Side-by-side KPI comparison table and overlaid context curves across any two local sessions.
- **Plain-Language Guide**: One-click `ZH` / `EN` toggle translating low-level telemetry into clear turn summaries and glossary cards.
- **Offline Export & Step Fork**: Export standalone single-file interactive HTML replay pages or Markdown audit reports; trigger a fork-like handoff conversation (`target: "new"`) from any historical step.

---

## Official Safe Mode Data Scope

- Reads only local Antigravity session artifacts (`transcript.jsonl`, `transcript_full.jsonl`, `.system_generated/steps/*/output.txt`, `.system_generated/tasks/task-*.log`) and passive lifecycle hooks (`SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, `Stop` -> `hooks/telemetry-hook.mjs`).
- Does **not** intercept network traffic, launch MITM proxies, or modify `CLOUD_CODE_URL`.
- **Transparent boundaries**: `thinking` reflects official Thought Summaries; built-in system prompts and schemas are not persisted locally; historical step "Fork" spawns a new handoff conversation (`target: "new"`) without mutating prior session history.

---

## Installation, Build & Tests

Install via **AGY Market** or deploy the built runtime files to `~/.gemini/config/plugins/trajectory-lens` (Windows: `%USERPROFILE%\.gemini\config\plugins\trajectory-lens`) and enable `trajectory-lens` in **Plugins Manager**.

For development from source:
```bash
npm install
npm run build:ui
npm test
```

---

## Attribution & License

Designed with AI assistance and re-implemented based on DSH's official model trajectory visualization features for Google Antigravity.

Licensed under the **MIT License** — see [`LICENSE`](./LICENSE).
