# Trajectory Lens (`trajectory-lens`)

> **声明 / Notice**：本项目为**使用 AI 辅助开发**、**基于 DSH 官方模型运行轨迹可视化功能重新设计与重开发**的 Google Antigravity 插件（官方零代理安全模式，非 DSH 或 Google 官方项目）。
>
> *Notice: This project is an independent AI-assisted plugin developed for Google Antigravity and re-implemented based on DSH's official model trajectory visualization features. It runs in Official Safe Mode (zero proxy) and is not an official DSH or Google product.*

---

## 核心特性（对标 DSH 官方轨迹功能重开发）

- **Turn / Step Ledger & Timeline（轮次/步骤台账与时间线）**：以 Turn 为层级关联 `PLANNER_RESPONSE` 思考摘要、并行工具调用、`GENERIC` 返回结果、`SYSTEM_MESSAGE`、`CHECKPOINT` 压缩边界与 `ERROR_MESSAGE` 事件，支持实时自动跟随与 `1x / 5x / 20x` 回放时间轴。
- **Execution Graph (DAG)（执行有向无环图）**：交互式 SVG DAG 视图，支持从左到右（`LR`）与从上到下（`TB`）两种布局、并行工具扇出与收敛边、按轮次/类别筛选、拖拽缩放及点击节点检视详情。
- **Multi-Agent Subagent Waterfall（多代理子代理瀑布流）**：递归关联 `invoke_subagent` 派生与 `send_message` 回调（读取 `~/.gemini/antigravity/brain/<childId>/`），构建层级 Span 树与挂钟时间瀑布流，支持一键下钻查看子代理轨迹。
- **Tokens, Prompt Cache & Latency Analytics（Token、缓存与耗时分析）**：双轴上下文增长与 Prompt Cache 命中率曲线、压缩边界标记、工具分类占比、Top-10 最慢调用、工作区涉及文件（支持侧边栏打开）及自动化模式洞察（重试循环、缓存跌落、耗时异常）。
- **Session Compare（双会话对比）**：任意两个本地会话的 KPI 差异对比表与上下文增长叠加曲线。
- **Plain-Language Guide（`白话导读`）**：一键切换 `ZH` / `EN` 通俗导读模式，将底层遥测翻译为面向初学者的轮次总结与术语卡片。
- **Offline Export & Step Fork（离线导出与历史步骤类 Fork 交接）**：导出可离线回放的单文件交互式 HTML 报告或 Markdown 审计报告；支持从任意历史步骤触发新交接会话（`target: "new"`）。

---

## 官方零代理安全模式与数据边界

- 仅读取本地会话产物：`transcript.jsonl`、`transcript_full.jsonl`、`.system_generated/steps/*/output.txt`、`.system_generated/tasks/task-*.log` 以及被动生命周期钩子（`SessionStart`、`PreInvocation`、`PostInvocation`、`PostToolUse`、`Stop` -> `hooks/telemetry-hook.mjs`）。
- **不拦截网络流量、不启动 MITM 代理、不修改 `CLOUD_CODE_URL`**。
- **透明数据边界说明**：
  - `thinking` 字段展示的是 Antigravity 官方落盘的 **Thought Summary**，而非原始未过滤思维链；
  - 内置系统提示词与底层工具 Schema 不会写入本地 transcript；
  - 历史步骤 **Fork** 通过结构化交接开启新会话（`target: "new"`），不会篡改或回滚原会话历史。

---

## 目录结构

| 路径 | 说明 |
|---|---|
| `hooks/telemetry-hook.mjs` | 被动生命周期钩子，记录执行耗时与工具事件台账 |
| `server/` | MCP Server（`mcp-server.mjs`）、轨迹解析（`parser.mjs`）、双会话对比（`compare.mjs`）、HTML/Markdown 导出（`exporter.mjs`）、路径解析（`paths.mjs`）、钩子台账（`hook-ledger.mjs`） |
| `ui/src/` & `ui/dist/app.html` | 交互式侧边面板前端源码、esbuild 构建脚本与单文件产物 |
| `skills/trajectory/` | `/trajectory` 技能定义 |
| `rules/AGENTS.md` | Trajectory Lens 官方安全模式与数据边界约束 |
| `scripts/install-global.mjs` | 同步构建产物与运行时文件至全局插件目录的辅助脚本 |
| `tests/` | 解析器与端到端 MCP 冒烟测试（`parser.test.mjs`、`mcp-smoke.test.mjs`） |

---

## 安装、构建与测试

1. 安装依赖、构建前端并运行测试：
   ```bash
   npm install
   npm run build:ui
   npm test
   ```
2. 将运行时文件部署到 Antigravity 插件目录：
   - 可将构建后的插件目录内容（`plugin.json`、`mcp_config.json`、`hooks.json`、`package.json`、`package-lock.json`、`README.md`、`LICENSE`、`assets/`、`hooks/`、`rules/`、`skills/`、`server/`、`ui/dist/`、`node_modules/`）复制至 `~/.gemini/config/plugins/trajectory-lens`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\trajectory-lens`），或运行 `npm run install:global`。
3. 在 Antigravity **Plugins Manager** 中启用 `trajectory-lens`（或重启 Antigravity），即可在侧边栏打开 **Trajectory Lens**。

---

## 声明与许可（Notice & License）

- 本插件功能设计与交互灵感源自 **DSH 官方模型轨迹可视化功能**，**全部代码为使用 AI 面向 Google Antigravity 重新设计与重开发实现**（官方安全模式，零代理）。
- 本项目基于 **MIT License** 开源，详见 [`LICENSE`](./LICENSE)。
