import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  discoverBrainRoots,
  getPluginDataDir,
  getPluginRoot,
  listAllSessions,
  readActiveSession,
  resolveLatestConversationId,
  resolveSessionPaths,
  toFileUri,
} from "./paths.mjs";
import { readHookEvents } from "./hook-ledger.mjs";
import {
  buildForkHandoff,
  getStepDetail,
  parseTrajectory,
  searchTrajectory,
} from "./parser.mjs";
import { compareSessions } from "./compare.mjs";
import { exportTrajectoryToFile } from "./exporter.mjs";

const APP_URI = "ui://trajectory-lens/app.html";
const SERVER_INFO = { name: "trajectory-lens", version: "1.0.0" };
const MAX_TOOL_PAYLOAD_BYTES = 650 * 1024;

const META_PANEL = {
  ui: { resourceUri: APP_URI },
  "com.google.antigravity/ui": {
    entrypoints: [
      { type: "aux_pane", title: "Trajectory Lens" },
      { type: "global", title: "Trajectory Lens" },
    ],
  },
};

const META_APP_ONLY = {
  ui: { visibility: ["app"] },
};

const TOOLS = [
  {
    name: "open_trajectory_lens",
    title: "Trajectory Lens",
    description:
      "Open the interactive Trajectory Lens visualizer (Side Pane or Global View) showing Antigravity turn/step ledger, parallel execution DAG, subagent span waterfall, token & prompt-cache pulse, session compare, plain-language guide, and offline HTML/Markdown export.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Antigravity conversation UUID to inspect (defaults to active/latest session).",
        },
        tab: {
          type: "string",
          enum: ["ledger", "graph", "subagents", "analytics", "compare", "sessions"],
          description: "Initial dashboard tab to open (optional).",
        },
        plainGuide: {
          type: "boolean",
          description: "Whether to open with Plain-Language Guide mode enabled (optional).",
        },
      },
      additionalProperties: false,
    },
    _meta: META_PANEL,
  },
  {
    name: "trajectory_summary",
    title: "Trajectory Summary",
    description:
      "Summarize an Antigravity conversation's execution trajectory: turns, steps, tool mix, errors, compaction checkpoints, prompt-cache hit rate, subagent calls, and bottleneck insights.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Antigravity conversation UUID (optional; defaults to active/latest session).",
        },
        includeTurns: {
          type: "boolean",
          description: "Include per-turn plain summaries in output text (default: true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "trajectory_search",
    title: "Search Trajectory Steps",
    description:
      "Search across an Antigravity session's full transcript for keywords, regex patterns, tool names, step types, or errors.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Antigravity conversation UUID (optional; defaults to active/latest session).",
        },
        query: {
          type: "string",
          description: "Keyword or regex pattern to search for (optional when filtering by errorsOnly/toolName).",
        },
        regex: {
          type: "boolean",
          description: "Treat query as regular expression (default: false).",
        },
        toolName: {
          type: "string",
          description: "Filter by exact tool name (e.g., run_command, edit_file).",
        },
        errorsOnly: {
          type: "boolean",
          description: "Only return error steps (default: false).",
        },
        limit: {
          type: "number",
          description: "Maximum matches to return (default: 30, max: 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "trajectory_export",
    title: "Export Trajectory Report",
    description:
      "Export an Antigravity conversation trajectory to a standalone interactive HTML replay page or structured Markdown audit report on disk.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Antigravity conversation UUID (optional; defaults to active/latest session).",
        },
        format: {
          type: "string",
          enum: ["html", "markdown"],
          description: "Export format: 'html' (standalone interactive replay) or 'markdown' (audit report). Default: 'html'.",
        },
        outputDir: {
          type: "string",
          description: "Optional custom output directory path.",
        },
      },
      additionalProperties: false,
    },
  },
  // --- App-only tools (hidden from model, invoked by ui:// app) ---
  {
    name: "app_list_sessions",
    title: "App: List Sessions",
    description: "App-only: list discovered local Antigravity sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        surface: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_load_trajectory",
    title: "App: Load Trajectory",
    description: "App-only: load parsed trajectory payload for a session.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        includeSubagentTree: { type: "boolean" },
      },
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_get_step_detail",
    title: "App: Get Step Detail",
    description: "App-only: fetch full untruncated step detail and external output slice.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        stepIndex: { type: "number" },
        artifactOffset: { type: "number" },
        artifactLimit: { type: "number" },
      },
      required: ["conversationId", "stepIndex"],
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_search_trajectory",
    title: "App: Search Trajectory",
    description: "App-only: search full transcript for steps.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        query: { type: "string" },
        regex: { type: "boolean" },
        stepTypes: { type: "array", items: { type: "string" } },
        toolName: { type: "string" },
        errorsOnly: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_compare_sessions",
    title: "App: Compare Sessions",
    description: "App-only: compare two sessions side-by-side.",
    inputSchema: {
      type: "object",
      properties: {
        leftConversationId: { type: "string" },
        rightConversationId: { type: "string" },
      },
      required: ["leftConversationId", "rightConversationId"],
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_export_trajectory",
    title: "App: Export Trajectory",
    description: "App-only: export standalone HTML or Markdown report.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        format: { type: "string", enum: ["html", "markdown"] },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_build_fork_handoff",
    title: "App: Build Fork Handoff",
    description: "App-only: build handoff summary prompt up to a chosen step for launching a new conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        upToStepIndex: { type: "number" },
        mode: { type: "string", enum: ["balanced", "compact"] },
      },
      required: ["conversationId", "upToStepIndex"],
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
  {
    name: "app_poll_revision",
    title: "App: Poll Revision",
    description: "App-only: cheap poll returning revision token and active conversation ID.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
      },
      additionalProperties: false,
    },
    _meta: META_APP_ONLY,
  },
];

function resolveUiHtmlPath() {
  const override = process.env.TRAJ_APP_HTML?.trim();
  if (override && fs.existsSync(override)) return override;
  return path.join(getPluginRoot(), "ui", "dist", "app.html");
}

function readUiHtml() {
  const htmlPath = resolveUiHtmlPath();
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf8");
  }
  return `<!doctype html><html><body><p>Trajectory Lens UI bundle not found at ${htmlPath}. Run <code>npm run build:ui</code>.</p></body></html>`;
}

function ensurePayloadWithinBudget(structured) {
  let json = JSON.stringify(structured);
  if (Buffer.byteLength(json, "utf8") <= MAX_TOOL_PAYLOAD_BYTES) {
    return structured;
  }

  const cloned = JSON.parse(json);
  const traj = cloned.trajectory;
  if (!traj) return cloned;

  // Pass 1: tighten previews while preserving full structure
  for (const s of traj.steps || []) {
    if (s.contentPreview && s.contentPreview.length > 80) {
      s.contentPreview = `${s.contentPreview.slice(0, 80)}…`;
      s.hasFullContent = true;
    }
    if (s.thinkingPreview && s.thinkingPreview.length > 80) {
      s.thinkingPreview = `${s.thinkingPreview.slice(0, 80)}…`;
      s.hasFullContent = true;
    }
  }
  for (const t of traj.turns || []) {
    for (const inv of t.invocations || []) {
      if (inv.thinkingPreview && inv.thinkingPreview.length > 100) {
        inv.thinkingPreview = `${inv.thinkingPreview.slice(0, 100)}…`;
      }
      if (inv.replyPreview && inv.replyPreview.length > 140) {
        inv.replyPreview = `${inv.replyPreview.slice(0, 140)}…`;
      }
      for (const tc of inv.toolCalls || []) {
        if (tc.outputPreview && tc.outputPreview.length > 80) {
          tc.outputPreview = `${tc.outputPreview.slice(0, 80)}…`;
          tc.hasFullOutput = true;
        }
      }
    }
  }

  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") <= MAX_TOOL_PAYLOAD_BYTES) {
    return cloned;
  }

  // Pass 2: deduplicate step previews (turns already holds ledger previews; steps keeps index & type for replay)
  traj.steps = (traj.steps || []).map((s) => ({
    stepIndex: s.stepIndex,
    turnIndex: s.turnIndex,
    type: s.type,
    status: s.status,
    hasFullContent: Boolean(s.hasFullContent),
  }));
  for (const n of traj.dag?.nodes || []) {
    if (n.sublabel && n.sublabel.length > 16) n.sublabel = n.sublabel.slice(0, 16);
  }

  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") <= MAX_TOOL_PAYLOAD_BYTES) {
    return cloned;
  }

  // Pass 3: ultra-compact mode for massive (>2000-step) sessions; full content stays on demand via app_get_step_detail
  for (const t of traj.turns || []) {
    for (const inv of t.invocations || []) {
      inv.thinkingPreview = "";
      inv.replyPreview = inv.replyPreview ? inv.replyPreview.slice(0, 60) : "";
      for (const tc of inv.toolCalls || []) {
        tc.outputPreview = "";
        tc.argsSummary = tc.argsSummary ? tc.argsSummary.slice(0, 48) : "";
        tc.hasFullOutput = true;
      }
    }
    for (const ev of t.events || []) {
      ev.contentPreview = ev.contentPreview ? ev.contentPreview.slice(0, 48) : "";
    }
  }
  for (const n of traj.dag?.nodes || []) {
    n.sublabel = "";
  }
  return cloned;
}

function formatSummaryText(traj, includeTurns = true) {
  const m = traj.meta;
  const ts = traj.tokenSummary;
  const lines = [
    `Trajectory Lens — ${m.title}`,
    `Conversation: ${m.conversationId} (${m.surface}) | Model: ${m.model || "unknown"}`,
    `Turns: ${m.turnCount} | Steps: ${m.stepCount} | Invocations: ${m.invocationCount} | Tool Calls: ${m.toolCallCount} | Errors: ${m.errorCount} | Compactions: ${m.compactionCount} | Subagents: ${m.subagentCount}`,
    `Tokens: input=${ts.totalInputTokens.toLocaleString()}, cacheRead=${ts.totalCacheReadTokens.toLocaleString()}, output=${ts.totalOutputTokens.toLocaleString()} | Peak Context=${ts.peakContextTokens.toLocaleString()} | Avg Cache Hit=${(ts.avgCacheHitRate * 100).toFixed(1)}%`,
  ];
  if (traj.analytics.insights.length > 0) {
    lines.push("Insights:");
    for (const ins of traj.analytics.insights) {
      lines.push(`- [${ins.severity}] ${ins.titleZh} (${ins.titleEn})`);
    }
  }
  if (includeTurns && traj.turns.length > 0) {
    lines.push("Turns:");
    for (const t of traj.turns.slice(0, 12)) {
      lines.push(`- Turn ${t.turnIndex}: ${t.plainSummary?.zh || t.userGoal || ""}`);
    }
    if (traj.turns.length > 12) {
      lines.push(`- ... (${traj.turns.length - 12} more turns)`);
    }
  }
  return lines.join("\n");
}

function getContext() {
  const pluginDataDir = getPluginDataDir();
  const brainRoots = discoverBrainRoots(pluginDataDir);
  const activeSession = readActiveSession(pluginDataDir);
  return { pluginDataDir, brainRoots, activeSession };
}

function resolveTargetId(requestedId, ctx) {
  if (requestedId && typeof requestedId === "string" && requestedId.trim()) {
    return requestedId.trim();
  }
  return resolveLatestConversationId({
    brainRoots: ctx.brainRoots,
    pluginDataDir: ctx.pluginDataDir,
  });
}

function handleToolCall(name, args = {}) {
  const ctx = getContext();

  if (name === "open_trajectory_lens") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    const sessions = listAllSessions({
      brainRoots: ctx.brainRoots,
      activeConversationId: ctx.activeSession?.conversationId || null,
      limit: 35,
      pluginDataDir: ctx.pluginDataDir,
    });

    let trajectory = null;
    let loadError = null;
    if (targetId) {
      try {
        trajectory = parseTrajectory(targetId, {
          brainRoots: ctx.brainRoots,
          pluginDataDir: ctx.pluginDataDir,
          previewChars: 240,
          includeSubagentTree: true,
        });
      } catch (err) {
        loadError = err.message;
      }
    }

    const structured = ensurePayloadWithinBudget({
      initialTab: args.tab || "ledger",
      plainGuide: typeof args.plainGuide === "boolean" ? args.plainGuide : false,
      activeConversationId: ctx.activeSession?.conversationId || null,
      selectedConversationId: targetId,
      sessions,
      trajectory,
      loadError,
    });

    const summaryText = trajectory
      ? formatSummaryText(trajectory, false)
      : `Trajectory Lens opened (${sessions.length} local sessions discovered${loadError ? `; error: ${loadError}` : ""}).`;

    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: structured,
    };
  }

  if (name === "trajectory_summary") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    if (!targetId) {
      return {
        content: [{ type: "text", text: "No local Antigravity conversation transcripts found." }],
        isError: true,
      };
    }
    const traj = parseTrajectory(targetId, {
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
      previewChars: 200,
      includeSubagentTree: true,
    });
    const text = formatSummaryText(traj, args.includeTurns !== false);
    return {
      content: [{ type: "text", text }],
      structuredContent: ensurePayloadWithinBudget({
        meta: traj.meta,
        tokenSummary: traj.tokenSummary,
        analytics: traj.analytics,
        subagentTree: traj.subagentTree,
      }),
    };
  }

  if (name === "trajectory_search") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    if (!targetId) {
      return {
        content: [{ type: "text", text: "No local Antigravity conversation transcripts found." }],
        isError: true,
      };
    }
    const res = searchTrajectory(targetId, {
      query: args.query || "",
      regex: Boolean(args.regex),
      toolName: args.toolName || null,
      errorsOnly: Boolean(args.errorsOnly),
      limit: Math.min(100, Number(args.limit) || 30),
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    const lines = [
      `Found ${res.totalMatches} matching step(s) in ${targetId}${res.query ? ` for "${res.query}"` : ""}:`,
      ...res.matches.map(
        (m) => `- Step #${m.stepIndex} (Turn ${m.turnIndex}, ${m.type}, ${m.field}): ${m.snippet.replace(/\r?\n/g, " ")}`
      ),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: res,
    };
  }

  if (name === "trajectory_export") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    if (!targetId) {
      return {
        content: [{ type: "text", text: "No local Antigravity conversation transcripts found." }],
        isError: true,
      };
    }
    const res = exportTrajectoryToFile(targetId, {
      format: args.format || "html",
      outputDir: args.outputDir || null,
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    return {
      content: [
        {
          type: "text",
          text: `Exported ${res.format.toUpperCase()} report (${(res.bytes / 1024).toFixed(1)} KiB) to ${res.fileUri} (${res.filePath})`,
        },
      ],
      structuredContent: res,
    };
  }

  if (name === "app_list_sessions") {
    const sessions = listAllSessions({
      brainRoots: ctx.brainRoots,
      activeConversationId: ctx.activeSession?.conversationId || null,
      limit: Number(args.limit) || 60,
      query: args.query || "",
      surface: args.surface || "all",
      pluginDataDir: ctx.pluginDataDir,
    });
    const payload = {
      activeConversationId: ctx.activeSession?.conversationId || null,
      sessions,
    };
    return {
      content: [{ type: "text", text: `${sessions.length} sessions` }],
      structuredContent: payload,
    };
  }

  if (name === "app_load_trajectory") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    if (!targetId) {
      return {
        content: [{ type: "text", text: "No local sessions found." }],
        structuredContent: { trajectory: null, error: "No local sessions found." },
      };
    }
    const traj = parseTrajectory(targetId, {
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
      previewChars: 240,
      includeSubagentTree: args.includeSubagentTree !== false,
    });
    const structured = ensurePayloadWithinBudget({ trajectory: traj });
    return {
      content: [{ type: "text", text: `Loaded ${targetId} (${traj.meta.stepCount} steps)` }],
      structuredContent: structured,
    };
  }

  if (name === "app_get_step_detail") {
    const detail = getStepDetail(args.conversationId, args.stepIndex, {
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
      artifactOffset: Number(args.artifactOffset) || 0,
      artifactLimit: Number(args.artifactLimit) || 32768,
    });
    // Include clickable file URIs for any paths inside tool call arguments or paired tool call
    const fileUris = [];
    const seenPaths = new Set();
    const collectArgPaths = (a) => {
      if (!a || typeof a !== "object") return;
      for (const k of ["Path", "path", "TargetFile", "FilePath", "file_path", "ScriptPath"]) {
        if (typeof a[k] === "string" && a[k].trim()) {
          const p = a[k].trim();
          if (!seenPaths.has(p)) {
            seenPaths.add(p);
            fileUris.push({ path: p, uri: toFileUri(p) });
          }
        }
      }
    };
    for (const tc of detail.toolCalls || []) collectArgPaths(tc?.args);
    if (detail.pairedToolCall?.args) collectArgPaths(detail.pairedToolCall.args);
    if (detail.hookEvent?.argsPreview) collectArgPaths(detail.hookEvent.argsPreview);
    detail.fileUris = fileUris;
    return {
      content: [{ type: "text", text: `Step #${detail.stepIndex} (${detail.type})` }],
      structuredContent: detail,
    };
  }

  if (name === "app_search_trajectory") {
    const res = searchTrajectory(args.conversationId, {
      query: args.query || "",
      regex: Boolean(args.regex),
      stepTypes: args.stepTypes || null,
      toolName: args.toolName || null,
      errorsOnly: Boolean(args.errorsOnly),
      limit: Number(args.limit) || 60,
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    return {
      content: [{ type: "text", text: `${res.totalMatches} matches` }],
      structuredContent: res,
    };
  }

  if (name === "app_compare_sessions") {
    const diff = compareSessions(args.leftConversationId, args.rightConversationId, {
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    return {
      content: [{ type: "text", text: "Comparison ready" }],
      structuredContent: diff,
    };
  }

  if (name === "app_export_trajectory") {
    const res = exportTrajectoryToFile(args.conversationId, {
      format: args.format || "html",
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    return {
      content: [{ type: "text", text: res.filePath }],
      structuredContent: res,
    };
  }

  if (name === "app_build_fork_handoff") {
    const res = buildForkHandoff(args.conversationId, args.upToStepIndex, {
      mode: args.mode || "balanced",
      brainRoots: ctx.brainRoots,
      pluginDataDir: ctx.pluginDataDir,
    });
    return {
      content: [{ type: "text", text: res.prompt }],
      structuredContent: res,
    };
  }

  if (name === "app_poll_revision") {
    const targetId = resolveTargetId(args.conversationId, ctx);
    let revision = null;
    if (targetId) {
      const sp = resolveSessionPaths(targetId, ctx.brainRoots);
      if (sp && fs.existsSync(sp.transcriptPath)) {
        const st = fs.statSync(sp.transcriptPath);
        const hookLedger = readHookEvents(ctx.pluginDataDir, targetId);
        revision = `${st.mtimeMs}:${st.size}:${hookLedger.eventCount}`;
      }
    }
    return {
      content: [{ type: "text", text: revision || "none" }],
      structuredContent: {
        conversationId: targetId,
        activeConversationId: ctx.activeSession?.conversationId || null,
        revision,
      },
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
}

export function createServer() {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: APP_URI,
        name: "Trajectory Lens Interactive UI",
        description:
          "DSH-grade Antigravity model execution trajectory visualizer (Turn/Step Ledger, DAG, Subagent Waterfall, Token/Cache Analytics, Compare, Plain Guide).",
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri;
    if (uri !== APP_URI) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
    }
    const html = readUiHtml();
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name;
    const args = request.params?.arguments || {};
    try {
      return handleToolCall(toolName, args);
    } catch (err) {
      if (err instanceof McpError) throw err;
      return {
        content: [{ type: "text", text: `Error in ${toolName}: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isEntrypoint) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
