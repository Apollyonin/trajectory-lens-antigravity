import fs from "node:fs";
import path from "node:path";
import {
  cleanUserInputTitle,
  discoverBrainRoots,
  getPluginDataDir,
  resolveSessionPaths,
} from "./paths.mjs";
import { readHookEvents } from "./hook-ledger.mjs";

const MAX_READ_BYTES = 24 * 1024 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COMPACTION_TYPES = new Set(["CHECKPOINT", "COMPACTION", "CONTEXT_COMPACTION"]);

const TOOL_CATEGORY_MAP = {
  read_file: "explore",
  view_file: "explore",
  view_file_outline: "explore",
  view_code_item: "explore",
  list_dir: "explore",
  find_by_name: "explore",
  grep_search: "explore",
  search_web: "explore",
  read_url_content: "explore",
  edit_file: "edit",
  write_file: "edit",
  write_to_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  run_command: "execute",
  command_status: "execute",
  send_command_input: "execute",
  read_terminal: "execute",
  manage_task: "execute",
  invoke_subagent: "agent",
  define_subagent: "agent",
  manage_subagents: "agent",
  send_message: "agent",
  swarm: "agent",
  enter_plan_mode: "agent",
  exit_plan_mode: "agent",
  ask_question: "agent",
  schedule: "agent",
  call_mcp_tool: "mcp",
  list_resources: "mcp",
  read_resource: "mcp",
  search_marketplace: "mcp",
  list_plugin_accounts: "mcp",
};

export function normalizeStepType(rawType) {
  return String(rawType || "UNKNOWN").replace(/^CORTEX_STEP_TYPE_/, "");
}

export function categorizeTool(name) {
  const n = String(name || "").trim();
  if (!n) return "other";
  if (TOOL_CATEGORY_MAP[n]) return TOOL_CATEGORY_MAP[n];
  if (n.startsWith("mcp_")) return "mcp";
  if (n.startsWith("browser_")) return "execute";
  if (n.includes("read") || n.includes("list") || n.includes("search") || n.includes("find") || n.includes("grep")) {
    return "explore";
  }
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "edit";
  if (n.includes("run") || n.includes("exec") || n.includes("command")) return "execute";
  if (n.includes("agent") || n.includes("swarm")) return "agent";
  return "other";
}

function nonNegInt(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function previewText(str, maxChars = 280) {
  if (typeof str !== "string") return { text: "", truncated: false, fullLength: 0 };
  if (str.length <= maxChars) return { text: str, truncated: false, fullLength: str.length };
  return {
    text: `${str.slice(0, maxChars)}…`,
    truncated: true,
    fullLength: str.length,
  };
}

function readTailUtf8(filePath, maxBytes = MAX_READ_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return {
      text: fs.readFileSync(filePath, "utf8"),
      partial: false,
      fileBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const offset = stat.size - maxBytes;
    const n = fs.readSync(fd, buf, 0, maxBytes, offset);
    let str = buf.subarray(0, n).toString("utf8");
    const firstNl = str.indexOf("\n");
    if (firstNl >= 0) str = str.slice(firstNl + 1);
    return {
      text: str,
      partial: true,
      fileBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parses a JSONL transcript and deduplicates rows by step_index keeping the latest occurrence.
 */
export function parseJsonlDeduplicated(filePath, { maxBytes = MAX_READ_BYTES } = {}) {
  const { text, partial, fileBytes, mtimeMs } = readTailUtf8(filePath, maxBytes);
  const byKey = new Map();
  let seq = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const idx = nonNegInt(obj.step_index);
    const key = idx !== null ? `idx:${idx}` : `seq:${seq}`;
    byKey.set(key, {
      order: idx !== null ? idx : seq,
      raw: obj,
    });
    seq++;
  }

  const rows = Array.from(byKey.values())
    .sort((a, b) => a.order - b.order)
    .map((item) => ({
      ...item.raw,
      step_index: nonNegInt(item.raw.step_index) ?? item.order,
      type: normalizeStepType(item.raw.type),
    }));

  return { rows, partial, fileBytes, mtimeMs };
}

export function parseToolTimestamps(content) {
  if (typeof content !== "string" || !content) {
    return { startedAt: null, completedAt: null, durationMs: null };
  }
  const m = content.match(
    /Created At:\s*([^\r\n]+)\r?\nCompleted At:\s*([^\r\n]+)/
  );
  if (!m) {
    const cOnly = content.match(/Created At:\s*([^\r\n]+)/);
    if (cOnly) {
      const sMs = Date.parse(cOnly[1].trim());
      return {
        startedAt: Number.isFinite(sMs) ? new Date(sMs).toISOString() : cOnly[1].trim(),
        completedAt: null,
        durationMs: null,
      };
    }
    return { startedAt: null, completedAt: null, durationMs: null };
  }
  const startStr = m[1].trim();
  const endStr = m[2].trim();
  const startMs = Date.parse(startStr);
  const endMs = Date.parse(endStr);
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : null;
  return {
    startedAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : startStr,
    completedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : endStr,
    durationMs,
  };
}

function detectToolError(toolName, genericRow) {
  if (!genericRow) return null;
  if (genericRow.error) return String(genericRow.error);
  if (genericRow.status === "ERROR") return "Step status ERROR";
  const content = typeof genericRow.content === "string" ? genericRow.content : "";
  if (!content) return null;
  if (toolName === "run_command") {
    const exitMatch = content.match(/Command exited with code\s+(-?\d+)/i);
    if (exitMatch && Number(exitMatch[1]) !== 0) {
      return `Exit code ${exitMatch[1]}`;
    }
  }
  if (/^Error executing tool\b/im.test(content) || /\bTool execution failed\b/i.test(content)) {
    const firstLine = content.split(/\r?\n/).find((l) => /error|failed/i.test(l));
    return firstLine ? firstLine.slice(0, 180) : "Tool error";
  }
  return null;
}

export function extractFileRefs(toolName, args, content) {
  const refs = new Set();
  if (args && typeof args === "object") {
    for (const key of ["Path", "path", "TargetFile", "FilePath", "file_path", "ScriptPath", "Cwd", "cwd"]) {
      const val = args[key];
      if (typeof val === "string" && val.trim() && (val.includes("/") || val.includes("\\"))) {
        refs.add(val.trim());
      }
    }
    if (typeof args.CommandLine === "string") {
      const matches = args.CommandLine.match(/(?:[A-Za-z]:\\|\/)[^\s"'`|<>]+/g);
      if (matches) {
        for (const m of matches.slice(0, 4)) refs.add(m);
      }
    }
  }

  let externalArtifact = null;
  if (typeof content === "string" && content) {
    const uriMatch = content.match(/file:\/\/\/([^\s)>'"]+\.(?:txt|log))/i);
    if (uriMatch) {
      let decoded = uriMatch[1];
      try {
        decoded = decodeURIComponent(decoded);
      } catch {}
      externalArtifact = process.platform === "win32" ? decoded.replace(/\//g, "\\") : `/${decoded}`;
    }
  }

  return {
    fileRefs: Array.from(refs),
    externalArtifact,
  };
}

export function extractSubagentSpawn(toolCall, pairedGenericContent) {
  const name = toolCall?.name;
  const args = toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};
  if (name === "invoke_subagent") {
    let childConversationId = null;
    if (typeof pairedGenericContent === "string") {
      const m =
        pairedGenericContent.match(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/i) ||
        pairedGenericContent.match(/conversationId[=:\s]+([0-9a-f-]{36})/i);
      if (m) childConversationId = m[1];
    }
    return {
      kind: "invoke_subagent",
      childConversationId,
      role: args.Role || args.role || args.TypeName || "Subagent",
      typeName: args.TypeName || args.typeName || "subagent",
      model: args.Model || args.model || "inherit",
      workspace: args.Workspace || args.workspace || "inherit",
      promptPreview: previewText(String(args.Prompt || args.prompt || ""), 180).text,
    };
  }
  if (name === "send_message" && typeof args.Recipient === "string" && UUID_RE.test(args.Recipient)) {
    const idMatch = args.Recipient.match(UUID_RE);
    return {
      kind: "send_message",
      childConversationId: idMatch ? idMatch[0] : null,
      role: "peer/subagent",
      typeName: "send_message",
      model: null,
      workspace: null,
      promptPreview: previewText(String(args.Message || ""), 180).text,
    };
  }
  return null;
}

function summarizeArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  if (args.CommandLine) return previewText(String(args.CommandLine), 120).text;
  if (args.Path) return previewText(String(args.Path), 120).text;
  if (args.TargetFile) return previewText(String(args.TargetFile), 120).text;
  if (args.query) return previewText(String(args.query), 120).text;
  if (args.Role || args.TypeName) {
    return `${args.TypeName || "subagent"}: ${args.Role || ""}`.trim();
  }
  if (args.toolSummary) return previewText(String(args.toolSummary), 120).text;
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .slice(0, 3)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${previewText(String(s), 45).text}`;
    });
  return entries.join(", ");
}

function findExternalArtifact(sessionPaths, stepIndex, parsedFromContent) {
  if (parsedFromContent && fs.existsSync(parsedFromContent)) {
    return parsedFromContent;
  }
  const stepOut = path.join(sessionPaths.stepsDir, String(stepIndex), "output.txt");
  if (fs.existsSync(stepOut)) return stepOut;
  const taskLog = path.join(sessionPaths.tasksDir, `task-${stepIndex}.log`);
  if (fs.existsSync(taskLog)) return taskLog;
  return null;
}

function detectSystemSubagentCallback(content) {
  if (typeof content !== "string" || !content) return null;
  const senderMatch = content.match(/sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (senderMatch) return { subagentId: senderMatch[1], kind: "message" };
  const hostFactsMatch = content.match(/\[BROWSER_HOST_FACTS\s+subagent=([0-9a-f-]{36})/i);
  if (hostFactsMatch) return { subagentId: hostFactsMatch[1], kind: "browser_facts" };
  return null;
}

function buildPlainTurnSummary(turn) {
  const goal = turn.userGoal ? previewText(turn.userGoal, 68).text : "初始化 / 系统引导";
  const toolCounts = {};
  let errCount = 0;
  let checkpointCount = 0;
  let subagentCount = 0;

  for (const inv of turn.invocations) {
    for (const tc of inv.toolCalls) {
      toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
      if (tc.error) errCount++;
      if (tc.subagentSpawn?.kind === "invoke_subagent") subagentCount++;
    }
  }
  for (const ev of turn.events) {
    if (ev.type === "CHECKPOINT") checkpointCount++;
    if (ev.type === "ERROR_MESSAGE") errCount++;
  }

  const totalTools = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, cnt]) => `${name}×${cnt}`)
    .join("、");

  const zhParts = [`模型在本轮共思考并执行 ${turn.invocations.length} 次推理`];
  if (totalTools > 0) zhParts.push(`调用工具 ${totalTools} 次（${topTools}）`);
  if (subagentCount > 0) zhParts.push(`派发 ${subagentCount} 个子智能体`);
  if (checkpointCount > 0) zhParts.push(`触发 ${checkpointCount} 次上下文压缩`);
  if (errCount > 0) zhParts.push(`遇到 ${errCount} 处错误/重试`);

  const enParts = [
    `${turn.invocations.length} model invocation(s) for "${turn.userGoal ? previewText(turn.userGoal, 48).text : "bootstrap"}"`,
  ];
  if (totalTools > 0) enParts.push(`${totalTools} tool call(s)`);
  if (subagentCount > 0) enParts.push(`${subagentCount} subagent(s)`);
  if (checkpointCount > 0) enParts.push(`${checkpointCount} checkpoint(s)`);
  if (errCount > 0) enParts.push(`${errCount} error(s)`);

  return {
    zh: `${turn.turnIndex === 0 ? "启动阶段：" : `针对「${goal}」：`}${zhParts.join("，")}。`,
    en: enParts.join(", ") + ".",
  };
}

function buildInsights({ steps, turns, perInvocationSeries, toolExecutions }) {
  const insights = [];
  let seq = 1;

  // 1. Repeated tool errors or consecutive errors on same tool
  const errorCalls = toolExecutions.filter((t) => t.error);
  if (errorCalls.length > 0) {
    const byTool = new Map();
    for (const tc of errorCalls) {
      if (!byTool.has(tc.name)) byTool.set(tc.name, []);
      byTool.get(tc.name).push(tc.stepIndex ?? tc.plannerStepIndex);
    }
    for (const [toolName, idxs] of byTool.entries()) {
      if (idxs.length >= 2) {
        insights.push({
          id: `ins-${seq++}`,
          severity: "warning",
          kind: "retry_loop",
          titleZh: `工具 ${toolName} 出现 ${idxs.length} 次失败/重试`,
          titleEn: `Tool ${toolName} failed ${idxs.length} times`,
          detailZh: `步骤 ${idxs.slice(0, 6).map((i) => `#${i}`).join("、")} 出现错误或非零退出，建议展开对应步骤的完整输出排查根因。`,
          detailEn: `Failures observed at step(s) ${idxs.slice(0, 6).map((i) => `#${i}`).join(", ")}.`,
          stepIndices: idxs.slice(0, 12),
        });
      }
    }
    if (insights.length === 0) {
      const idxs = errorCalls.map((t) => t.stepIndex ?? t.plannerStepIndex);
      insights.push({
        id: `ins-${seq++}`,
        severity: "info",
        kind: "error_hotspot",
        titleZh: `会话内共有 ${errorCalls.length} 个工具步骤报错`,
        titleEn: `${errorCalls.length} tool step(s) reported errors`,
        detailZh: `可点击下方步骤编号直接定位排查：${idxs.slice(0, 6).map((i) => `#${i}`).join("、")}。`,
        detailEn: `Check step(s) ${idxs.slice(0, 6).map((i) => `#${i}`).join(", ")}.`,
        stepIndices: idxs.slice(0, 12),
      });
    }
  }

  // 2. Prompt cache hit-rate drop > 25% between consecutive invocations (after warm-up)
  for (let i = 1; i < perInvocationSeries.length; i++) {
    const prev = perInvocationSeries[i - 1];
    const curr = perInvocationSeries[i];
    if (prev.cacheHitRate >= 0.5 && prev.cacheHitRate - curr.cacheHitRate >= 0.25) {
      insights.push({
        id: `ins-${seq++}`,
        severity: "warning",
        kind: "cache_drop",
        titleZh: `Step #${curr.stepIndex} 前缀缓存命中率骤降`,
        titleEn: `Prompt cache hit rate dropped at Step #${curr.stepIndex}`,
        detailZh: `缓存命中率从 ${(prev.cacheHitRate * 100).toFixed(1)}% 降至 ${(curr.cacheHitRate * 100).toFixed(1)}%（新增未命中 ${curr.inputTokens.toLocaleString()} tokens），通常源于前序消息变动或上下文压缩重置。`,
        detailEn: `Hit rate fell from ${(prev.cacheHitRate * 100).toFixed(1)}% to ${(curr.cacheHitRate * 100).toFixed(1)}% (${curr.inputTokens.toLocaleString()} uncached input tokens).`,
        stepIndices: [curr.stepIndex],
      });
    }
  }

  // 3. Compaction checkpoints
  const checkpoints = steps.filter((s) => COMPACTION_TYPES.has(s.type));
  if (checkpoints.length > 0) {
    insights.push({
      id: `ins-${seq++}`,
      severity: "info",
      kind: "compaction",
      titleZh: `共触发 ${checkpoints.length} 次上下文压缩检查点`,
      titleEn: `${checkpoints.length} context compaction checkpoint(s)`,
      detailZh: `检查点位于步骤 ${checkpoints.map((c) => `#${c.stepIndex}`).join("、")}，压缩后上下文窗口显著回落。`,
      detailEn: `Checkpoints at step(s) ${checkpoints.map((c) => `#${c.stepIndex}`).join(", ")}.`,
      stepIndices: checkpoints.map((c) => c.stepIndex),
    });
  }

  // 4. Slowest step outlier (>= 12s)
  const slow = [...toolExecutions]
    .filter((t) => typeof t.durationMs === "number" && t.durationMs >= 12000)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3);
  if (slow.length > 0) {
    insights.push({
      id: `ins-${seq++}`,
      severity: "info",
      kind: "latency_outlier",
      titleZh: `发现 ${slow.length} 个高耗时工具步骤（最长 ${(slow[0].durationMs / 1000).toFixed(1)}s）`,
      titleEn: `${slow.length} slow tool call(s) (max ${(slow[0].durationMs / 1000).toFixed(1)}s)`,
      detailZh: slow
        .map((s) => `#${s.stepIndex ?? s.plannerStepIndex} ${s.name} (${(s.durationMs / 1000).toFixed(1)}s)`)
        .join("；"),
      detailEn: slow
        .map((s) => `#${s.stepIndex ?? s.plannerStepIndex} ${s.name} (${(s.durationMs / 1000).toFixed(1)}s)`)
        .join("; "),
      stepIndices: slow.map((s) => s.stepIndex ?? s.plannerStepIndex),
    });
  }

  // 5. Parallel tool fan-out summary
  let maxFanOut = 0;
  let maxFanOutStep = null;
  for (const t of turns) {
    for (const inv of t.invocations) {
      if (inv.toolCalls.length > maxFanOut) {
        maxFanOut = inv.toolCalls.length;
        maxFanOutStep = inv.stepIndex;
      }
    }
  }
  if (maxFanOut >= 3 && maxFanOutStep !== null) {
    insights.push({
      id: `ins-${seq++}`,
      severity: "success",
      kind: "parallel_fanout",
      titleZh: `单步最大并行扇出 ${maxFanOut} 个工具调用（Step #${maxFanOutStep}）`,
      titleEn: `Peak parallel tool fan-out: ${maxFanOut} calls at Step #${maxFanOutStep}`,
      detailZh: `模型在单次推理中并发调度了多个无依赖工具，可在 DAG 图谱视图查看扇出与汇聚拓扑。`,
      detailEn: `Inspect the Execution DAG tab to visualize concurrent branches and join convergence.`,
      stepIndices: [maxFanOutStep],
    });
  }

  return insights;
}

function buildExecutionDag(turns) {
  const nodes = [];
  const edges = [];

  let pendingExitIds = [];

  const connectFromPending = (targetId, kind = "flow") => {
    for (const srcId of pendingExitIds) {
      if (srcId && srcId !== targetId) {
        edges.push({ from: srcId, to: targetId, kind });
      }
    }
  };

  for (const turn of turns) {
    const turnIdx = turn.turnIndex;

    if (turn.userStepIndex !== null && turn.userStepIndex !== undefined) {
      const uNodeId = `step-${turn.userStepIndex}`;
      nodes.push({
        id: uNodeId,
        stepIndex: turn.userStepIndex,
        turnIndex: turnIdx,
        kind: "user",
        category: "user",
        label: previewText(turn.userGoal || `Turn ${turnIdx}`, 32).text,
        status: "DONE",
        durationMs: null,
        tokens: null,
      });
      connectFromPending(uNodeId, "turn");
      pendingExitIds = [uNodeId];
    }

    const invs = turn.invocations || [];
    for (let i = 0; i < invs.length; i++) {
      const inv = invs[i];
      const pNodeId = `step-${inv.stepIndex}`;
      const hasTools = inv.toolCalls.length > 0;
      nodes.push({
        id: pNodeId,
        stepIndex: inv.stepIndex,
        turnIndex: turnIdx,
        kind: hasTools ? "planner" : "reply",
        category: "model",
        label: hasTools
          ? `Planner #${inv.stepIndex} (${inv.toolCalls.length})`
          : `Reply #${inv.stepIndex}`,
        sublabel: inv.model || "",
        status: inv.status || "DONE",
        durationMs: inv.durationMs,
        tokens: inv.contextTokens || null,
        outputTokens: inv.outputTokens || null,
        cacheHitRate: inv.cacheHitRate,
      });

      connectFromPending(pNodeId, pendingExitIds.length > 1 ? "join" : "flow");

      if (hasTools) {
        const branchNodeIds = [];
        for (let t = 0; t < inv.toolCalls.length; t++) {
          const tc = inv.toolCalls[t];
          const tNodeId =
            tc.stepIndex !== null && tc.stepIndex !== undefined
              ? `step-${tc.stepIndex}`
              : `tc-${inv.stepIndex}-${t}`;
          const isSubagent = Boolean(tc.subagentSpawn?.childConversationId);
          nodes.push({
            id: tNodeId,
            stepIndex: tc.stepIndex ?? inv.stepIndex,
            turnIndex: turnIdx,
            kind: isSubagent ? "subagent" : "tool",
            category: tc.category,
            label: tc.name,
            sublabel: previewText(tc.argsSummary || "", 26).text,
            status: tc.error ? "ERROR" : tc.status || "DONE",
            durationMs: tc.durationMs,
            tokens: null,
            error: tc.error || null,
            childConversationId: tc.subagentSpawn?.childConversationId || null,
            parallelIndex: t,
            parallelTotal: inv.toolCalls.length,
          });
          edges.push({
            from: pNodeId,
            to: tNodeId,
            kind: inv.toolCalls.length > 1 ? "parallel" : "tool",
          });
          branchNodeIds.push(tNodeId);
        }
        pendingExitIds = branchNodeIds;
      } else {
        pendingExitIds = [pNodeId];
      }
    }

    for (const ev of turn.events || []) {
      if (ev.type === "CHECKPOINT" || ev.type === "ERROR_MESSAGE") {
        const eNodeId = `step-${ev.stepIndex}`;
        nodes.push({
          id: eNodeId,
          stepIndex: ev.stepIndex,
          turnIndex: turnIdx,
          kind: ev.type === "CHECKPOINT" ? "checkpoint" : "error",
          category: ev.type === "CHECKPOINT" ? "system" : "error",
          label:
            ev.type === "CHECKPOINT"
              ? `Compaction #${ev.stepIndex}`
              : `Error #${ev.stepIndex}`,
          status: ev.status || "DONE",
          durationMs: null,
          tokens: ev.contextTokens || null,
        });
        connectFromPending(eNodeId, "system");
        pendingExitIds = [eNodeId];
      }
    }
  }

  return { nodes, edges };
}

function parseSingleSession(conversationId, {
  brainRoots,
  pluginDataDir,
  previewChars = 280,
}) {
  const sessionPaths = resolveSessionPaths(conversationId, brainRoots);
  if (!sessionPaths) {
    throw new Error(`Conversation ${conversationId} not found in local Antigravity brain roots.`);
  }

  const parsed = parseJsonlDeduplicated(sessionPaths.transcriptPath);
  const rows = parsed.rows;
  const hookLedger = readHookEvents(pluginDataDir, conversationId);

  const turns = [];
  let currentTurn = {
    turnIndex: 0,
    userStepIndex: null,
    userGoal: null,
    startedAt: null,
    endedAt: null,
    invocations: [],
    events: [],
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
  };

  const perInvocationSeries = [];
  const toolExecutions = [];
  const compactSteps = [];
  const toolCounts = {};
  const categoryCounts = {};
  const fileTouchCounts = {};
  const checkpoints = [];
  const modelsUsed = new Set();
  const subagentRefs = new Map();
  const workspacePathsSet = new Set(hookLedger.sessionMeta?.workspacePaths || []);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let peakContextTokens = 0;
  let latestContextTokens = 0;
  let totalErrorCount = 0;
  let sessionStartMs = null;
  let sessionEndMs = null;
  let title = null;
  let latestModel = hookLedger.sessionMeta?.modelName || null;

  // First pass: index rows by position and track step timing
  const rowIndexMap = new Map();
  rows.forEach((r, idx) => rowIndexMap.set(r.step_index, idx));

  const consumedGenericStepIndices = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const stepIdx = r.step_index;
    const stepMs = r.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isFinite(stepMs)) {
      if (sessionStartMs === null || stepMs < sessionStartMs) sessionStartMs = stepMs;
      if (sessionEndMs === null || stepMs > sessionEndMs) sessionEndMs = stepMs;
    }

    if (r.model) {
      latestModel = r.model;
      modelsUsed.add(r.model);
    }

    if (r.type === "USER_INPUT") {
      if (!title && r.content) {
        title = cleanUserInputTitle(r.content);
      }
      // Push previous turn if it has anything
      if (
        currentTurn.turnIndex > 0 ||
        currentTurn.invocations.length > 0 ||
        currentTurn.events.length > 0
      ) {
        turns.push(currentTurn);
      }
      const nextTurnIndex = turns.length === 0 && currentTurn.invocations.length === 0 && currentTurn.events.length === 0
        ? 1
        : currentTurn.turnIndex + 1;
      currentTurn = {
        turnIndex: nextTurnIndex,
        userStepIndex: stepIdx,
        userGoal: cleanUserInputTitle(r.content, 400) || previewText(r.content || "", 400).text,
        startedAt: r.created_at || null,
        endedAt: r.created_at || null,
        invocations: [],
        events: [],
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        totalOutputTokens: 0,
      };

      const p = previewText(r.content || "", 400);
      compactSteps.push({
        stepIndex: stepIdx,
        turnIndex: currentTurn.turnIndex,
        type: r.type,
        source: r.source || "USER_EXPLICIT",
        status: r.status || "DONE",
        createdAt: r.created_at || null,
        model: null,
        contentPreview: p.text,
        hasFullContent: p.truncated || Boolean(r.truncated_fields?.length),
        mediaCount: Array.isArray(r.media) ? r.media.length : 0,
      });
      continue;
    }

    if (r.type === "PLANNER_RESPONSE") {
      if (currentTurn.turnIndex === 0 && !currentTurn.startedAt) {
        currentTurn.startedAt = r.created_at || null;
      }
      if (r.created_at) currentTurn.endedAt = r.created_at;

      const inTok = nonNegInt(r.input_tokens) ?? 0;
      const outTok = nonNegInt(r.output_tokens) ?? 0;
      const cacheTok = nonNegInt(r.cache_read_tokens) ?? 0;
      const contextTok = inTok + cacheTok;
      const cacheHitRate = contextTok > 0 ? cacheTok / contextTok : 0;

      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      totalCacheReadTokens += cacheTok;
      if (contextTok > peakContextTokens) peakContextTokens = contextTok;
      if (contextTok > 0) latestContextTokens = contextTok;

      currentTurn.totalInputTokens += inTok;
      currentTurn.totalCacheReadTokens += cacheTok;
      currentTurn.totalOutputTokens += outTok;

      const invIndex = perInvocationSeries.length;
      const hookInv = hookLedger.invocations[invIndex] || null;
      let invDurationMs = hookInv?.durationMs ?? null;
      if (invDurationMs === null && i > 0) {
        const prevMs = rows[i - 1]?.created_at ? Date.parse(rows[i - 1].created_at) : NaN;
        if (Number.isFinite(stepMs) && Number.isFinite(prevMs)) {
          invDurationMs = Math.max(0, stepMs - prevMs);
        }
      }

      if (contextTok > 0 || outTok > 0) {
        perInvocationSeries.push({
          stepIndex: stepIdx,
          turnIndex: currentTurn.turnIndex,
          ts: r.created_at || null,
          model: r.model || latestModel,
          inputTokens: inTok,
          cacheReadTokens: cacheTok,
          outputTokens: outTok,
          contextTokens: contextTok,
          cacheHitRate,
        });
      }

      const rawToolCalls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      // Find matching GENERIC steps immediately following this PLANNER_RESPONSE before the next PLANNER_RESPONSE or USER_INPUT
      const genericCandidates = [];
      for (let j = i + 1; j < rows.length && genericCandidates.length < rawToolCalls.length; j++) {
        const cand = rows[j];
        if (cand.type === "PLANNER_RESPONSE" || cand.type === "USER_INPUT") break;
        if (cand.type === "GENERIC" && !consumedGenericStepIndices.has(cand.step_index)) {
          genericCandidates.push(cand);
        }
      }

      const pairedToolCalls = rawToolCalls.map((tc, idx) => {
        const matchedGeneric = genericCandidates[idx] || null;
        if (matchedGeneric) {
          consumedGenericStepIndices.add(matchedGeneric.step_index);
        }
        const matchedStepIdx = matchedGeneric ? matchedGeneric.step_index : null;
        const hookTool =
          matchedStepIdx !== null ? hookLedger.postToolByStepIdx.get(matchedStepIdx) : null;
        const toolName = String(tc?.name || hookTool?.name || "unknown");
        const category = categorizeTool(toolName);
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;

        const tsInfo = parseToolTimestamps(matchedGeneric?.content || "");
        const error =
          hookTool?.error || detectToolError(toolName, matchedGeneric) || null;
        if (error) totalErrorCount++;

        const { fileRefs, externalArtifact } = extractFileRefs(
          toolName,
          tc?.args,
          matchedGeneric?.content || ""
        );
        for (const fp of fileRefs) {
          fileTouchCounts[fp] = (fileTouchCounts[fp] || 0) + 1;
        }
        const resolvedArtifact =
          matchedStepIdx !== null
            ? findExternalArtifact(sessionPaths, matchedStepIdx, externalArtifact)
            : null;

        const subSpawn = extractSubagentSpawn(tc, matchedGeneric?.content || "");
        if (subSpawn?.childConversationId) {
          const existing = subagentRefs.get(subSpawn.childConversationId) || {
            conversationId: subSpawn.childConversationId,
            role: subSpawn.role,
            typeName: subSpawn.typeName,
            model: subSpawn.model,
            workspace: subSpawn.workspace,
            spawnStepIndex: stepIdx,
            resultStepIndex: matchedStepIdx,
            callbackStepIndices: [],
          };
          if (subSpawn.kind === "invoke_subagent") {
            existing.role = subSpawn.role;
            existing.typeName = subSpawn.typeName;
            existing.model = subSpawn.model;
            existing.workspace = subSpawn.workspace;
            existing.spawnStepIndex = stepIdx;
            existing.resultStepIndex = matchedStepIdx;
          }
          subagentRefs.set(subSpawn.childConversationId, existing);
        }

        const outPrev = previewText(matchedGeneric?.content || "", previewChars);
        const execRecord = {
          indexInInvocation: idx,
          plannerStepIndex: stepIdx,
          stepIndex: matchedStepIdx,
          toolCallId: hookTool?.toolCallId || null,
          name: toolName,
          category,
          argsSummary: summarizeArgs(toolName, tc?.args),
          status: error ? "ERROR" : matchedGeneric?.status || "DONE",
          error,
          startedAt: tsInfo.startedAt || matchedGeneric?.created_at || r.created_at || null,
          completedAt: tsInfo.completedAt || hookTool?.completedIso || null,
          durationMs: tsInfo.durationMs,
          outputPreview: outPrev.text,
          hasFullOutput:
            outPrev.truncated ||
            Boolean(matchedGeneric?.truncated_fields?.length) ||
            Boolean(resolvedArtifact),
          externalArtifact: resolvedArtifact,
          fileRefs,
          subagentSpawn: subSpawn,
        };
        toolExecutions.push(execRecord);
        return execRecord;
      });

      const thinkPrev = previewText(r.thinking || "", 360);
      const replyPrev = previewText(r.content || "", 700);
      const hasFullPlanner =
        thinkPrev.truncated ||
        replyPrev.truncated ||
        Boolean(r.truncated_fields?.length);

      const invObj = {
        invocationIndex: invIndex,
        stepIndex: stepIdx,
        model: r.model || latestModel,
        status: r.status || "DONE",
        createdAt: r.created_at || null,
        durationMs: invDurationMs,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        contextTokens: contextTok,
        cacheHitRate,
        thinkingPreview: thinkPrev.text,
        thinkingLength: r.thinking ? r.thinking.length : 0,
        replyPreview: replyPrev.text,
        replyLength: r.content ? r.content.length : 0,
        hasFullContent: hasFullPlanner,
        toolCalls: pairedToolCalls,
      };
      currentTurn.invocations.push(invObj);

      compactSteps.push({
        stepIndex: stepIdx,
        turnIndex: currentTurn.turnIndex,
        type: r.type,
        source: r.source || "MODEL",
        status: r.status || "DONE",
        createdAt: r.created_at || null,
        model: r.model || latestModel,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        contextTokens: contextTok,
        cacheHitRate,
        durationMs: invDurationMs,
        thinkingPreview: thinkPrev.text,
        thinkingLength: r.thinking ? r.thinking.length : 0,
        contentPreview: replyPrev.text,
        toolCallNames: pairedToolCalls.map((t) => t.name),
        hasFullContent: hasFullPlanner,
      });
      continue;
    }

    // GENERIC step (usually already paired, still put into compactSteps so step lookup & scrubber stay contiguous)
    if (r.type === "GENERIC") {
      if (r.created_at) currentTurn.endedAt = r.created_at;
      const pairedExec = toolExecutions.find((t) => t.stepIndex === stepIdx) || null;
      const p = previewText(r.content || "", previewChars);
      const tsInfo = parseToolTimestamps(r.content || "");
      const extArt =
        pairedExec?.externalArtifact || findExternalArtifact(sessionPaths, stepIdx, null);
      compactSteps.push({
        stepIndex: stepIdx,
        turnIndex: currentTurn.turnIndex,
        type: r.type,
        source: r.source || "MODEL",
        status: pairedExec?.error ? "ERROR" : r.status || "DONE",
        createdAt: r.created_at || null,
        completedAt: tsInfo.completedAt,
        durationMs: tsInfo.durationMs,
        toolName: pairedExec?.name || null,
        toolCallId: pairedExec?.toolCallId || null,
        category: pairedExec?.category || null,
        argsSummary: pairedExec?.argsSummary || null,
        error: pairedExec?.error || r.error || null,
        contentPreview: p.text,
        fileRefs: pairedExec?.fileRefs || [],
        externalArtifact: extArt,
        hasFullContent:
          p.truncated || Boolean(r.truncated_fields?.length) || Boolean(extArt),
      });
      if (!pairedExec) {
        // Standalone GENERIC not linked to a PLANNER_RESPONSE (rare)
        currentTurn.events.push({
          stepIndex: stepIdx,
          type: r.type,
          source: r.source || "SYSTEM",
          status: r.status || "DONE",
          createdAt: r.created_at || null,
          contentPreview: p.text,
          hasFullContent: p.truncated || Boolean(r.truncated_fields?.length),
        });
      }
      continue;
    }

    // SYSTEM_MESSAGE, CHECKPOINT, ERROR_MESSAGE, or other event steps
    if (r.created_at) currentTurn.endedAt = r.created_at;
    const isCheckpoint = COMPACTION_TYPES.has(r.type);
    const isError = r.type === "ERROR_MESSAGE" || r.status === "ERROR" || Boolean(r.error);
    if (isError) totalErrorCount++;

    const inTok = nonNegInt(r.input_tokens);
    const cacheTok = nonNegInt(r.cache_read_tokens);
    const outTok = nonNegInt(r.output_tokens);
    const contextTok =
      inTok !== null || cacheTok !== null ? (inTok ?? 0) + (cacheTok ?? 0) : null;

    if (isCheckpoint) {
      checkpoints.push({
        stepIndex: stepIdx,
        turnIndex: currentTurn.turnIndex,
        createdAt: r.created_at || null,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        contextTokens: contextTok,
        summaryPreview: previewText(r.content || "", 240).text,
      });
    }

    const cb = r.type === "SYSTEM_MESSAGE" ? detectSystemSubagentCallback(r.content || "") : null;
    if (cb && subagentRefs.has(cb.subagentId)) {
      subagentRefs.get(cb.subagentId).callbackStepIndices.push(stepIdx);
    }

    const p = previewText(r.content || r.error || "", previewChars);
    const evObj = {
      stepIndex: stepIdx,
      turnIndex: currentTurn.turnIndex,
      type: r.type,
      source: r.source || "SYSTEM",
      status: r.status || "DONE",
      createdAt: r.created_at || null,
      error: r.error ? String(r.error) : null,
      contextTokens: contextTok,
      contentPreview: p.text,
      subagentCallbackId: cb?.subagentId || null,
      hasFullContent: p.truncated || Boolean(r.truncated_fields?.length),
    };
    currentTurn.events.push(evObj);
    compactSteps.push(evObj);
  }

  // Push final turn
  if (
    currentTurn.turnIndex > 0 ||
    currentTurn.invocations.length > 0 ||
    currentTurn.events.length > 0
  ) {
    turns.push(currentTurn);
  }

  // Add duration and plain summaries to turns
  for (const t of turns) {
    const sMs = t.startedAt ? Date.parse(t.startedAt) : NaN;
    const eMs = t.endedAt ? Date.parse(t.endedAt) : NaN;
    t.durationMs =
      Number.isFinite(sMs) && Number.isFinite(eMs) ? Math.max(0, eMs - sMs) : null;
    t.plainSummary = buildPlainTurnSummary(t);
  }

  const totalDenominator = totalInputTokens + totalCacheReadTokens;
  const avgCacheHitRate = totalDenominator > 0 ? totalCacheReadTokens / totalDenominator : 0;

  const durationMs =
    sessionStartMs !== null && sessionEndMs !== null
      ? Math.max(0, sessionEndMs - sessionStartMs)
      : null;

  const slowestSteps = [...toolExecutions]
    .filter((t) => typeof t.durationMs === "number")
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((t) => ({
      stepIndex: t.stepIndex ?? t.plannerStepIndex,
      name: t.name,
      category: t.category,
      durationMs: t.durationMs,
      argsSummary: t.argsSummary,
      status: t.status,
    }));

  const topFiles = Object.entries(fileTouchCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([filePath, count]) => ({ filePath, count }));

  const insights = buildInsights({
    steps: compactSteps,
    turns,
    perInvocationSeries,
    toolExecutions,
  });

  const dag = buildExecutionDag(turns);

  const revision = `${parsed.mtimeMs}:${parsed.fileBytes}:${hookLedger.eventCount}`;

  return {
    meta: {
      conversationId,
      surface: sessionPaths.surface,
      title: title || `Session ${conversationId.slice(0, 8)}`,
      model: latestModel,
      modelsUsed: Array.from(modelsUsed),
      startedAt: sessionStartMs !== null ? new Date(sessionStartMs).toISOString() : null,
      endedAt: sessionEndMs !== null ? new Date(sessionEndMs).toISOString() : null,
      durationMs,
      stepCount: compactSteps.length,
      turnCount: turns.length,
      invocationCount: perInvocationSeries.length || turns.reduce((a, t) => a + t.invocations.length, 0),
      toolCallCount: toolExecutions.length,
      errorCount: totalErrorCount,
      compactionCount: checkpoints.length,
      subagentCount: subagentRefs.size,
      hasHookTelemetry: hookLedger.hasTelemetry,
      hookEventCount: hookLedger.eventCount,
      stops: hookLedger.stops,
      workspacePaths: Array.from(workspacePathsSet),
      partialTranscript: parsed.partial,
      transcriptBytes: parsed.fileBytes,
      revision,
      limitations: {
        officialSafeMode: true,
        thoughtSummaryOnly: true,
        builtInSystemPromptHidden: true,
        forkMode: "handoff_new_conversation",
      },
    },
    tokenSummary: {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      peakContextTokens,
      latestContextTokens,
      avgCacheHitRate,
      perInvocationSeries,
    },
    turns,
    steps: compactSteps,
    dag,
    subagentRefs: Array.from(subagentRefs.values()),
    analytics: {
      toolCounts,
      categoryCounts,
      slowestSteps,
      fileTouchCounts: topFiles,
      checkpoints,
      insights,
    },
  };
}

function buildSubagentTreeRecursive(
  conversationId,
  metaOverride,
  { brainRoots, pluginDataDir, depth = 0, maxDepth = 4, visited = new Set() }
) {
  if (visited.has(conversationId)) return null;
  visited.add(conversationId);

  let parsed = null;
  try {
    parsed = parseSingleSession(conversationId, {
      brainRoots,
      pluginDataDir,
      previewChars: 140,
    });
  } catch {
    return {
      conversationId,
      role: metaOverride?.role || "Subagent",
      typeName: metaOverride?.typeName || "subagent",
      model: metaOverride?.model || null,
      spawnStepIndex: metaOverride?.spawnStepIndex ?? null,
      callbackStepIndices: metaOverride?.callbackStepIndices || [],
      status: "MISSING_TRANSCRIPT",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      stepCount: 0,
      toolCallCount: 0,
      totalTokens: 0,
      errorCount: 0,
      children: [],
    };
  }

  const children = [];
  if (depth < maxDepth) {
    for (const ref of parsed.subagentRefs || []) {
      const child = buildSubagentTreeRecursive(ref.conversationId, ref, {
        brainRoots,
        pluginDataDir,
        depth: depth + 1,
        maxDepth,
        visited,
      });
      if (child) children.push(child);
    }
  }

  return {
    conversationId,
    title: parsed.meta.title,
    role: metaOverride?.role || "Root Coordinator",
    typeName: metaOverride?.typeName || "root",
    model: parsed.meta.model || metaOverride?.model || null,
    spawnStepIndex: metaOverride?.spawnStepIndex ?? null,
    callbackStepIndices: metaOverride?.callbackStepIndices || [],
    status: parsed.meta.errorCount > 0 ? "COMPLETED_WITH_ERRORS" : "DONE",
    startedAt: parsed.meta.startedAt,
    endedAt: parsed.meta.endedAt,
    durationMs: parsed.meta.durationMs,
    stepCount: parsed.meta.stepCount,
    toolCallCount: parsed.meta.toolCallCount,
    totalTokens:
      parsed.tokenSummary.totalInputTokens +
      parsed.tokenSummary.totalCacheReadTokens +
      parsed.tokenSummary.totalOutputTokens,
    errorCount: parsed.meta.errorCount,
    children,
  };
}

export function parseTrajectory(
  conversationId,
  {
    brainRoots,
    pluginDataDir = getPluginDataDir(),
    previewChars = 280,
    includeSubagentTree = true,
    maxDepth = 4,
  } = {}
) {
  const roots = brainRoots && brainRoots.length > 0 ? brainRoots : discoverBrainRoots(pluginDataDir);
  const traj = parseSingleSession(conversationId, {
    brainRoots: roots,
    pluginDataDir,
    previewChars,
  });

  if (includeSubagentTree) {
    traj.subagentTree = buildSubagentTreeRecursive(conversationId, null, {
      brainRoots: roots,
      pluginDataDir,
      depth: 0,
      maxDepth,
      visited: new Set(),
    });
  } else {
    traj.subagentTree = null;
  }

  return traj;
}

export function getStepDetail(
  conversationId,
  stepIndex,
  {
    brainRoots,
    pluginDataDir = getPluginDataDir(),
    artifactOffset = 0,
    artifactLimit = 32768,
  } = {}
) {
  const roots = brainRoots && brainRoots.length > 0 ? brainRoots : discoverBrainRoots(pluginDataDir);
  const sessionPaths = resolveSessionPaths(conversationId, roots);
  if (!sessionPaths) {
    throw new Error(`Conversation ${conversationId} not found.`);
  }

  const parsed = parseJsonlDeduplicated(sessionPaths.transcriptFullPath);
  const targetIdx = Number(stepIndex);
  const rowPos = parsed.rows.findIndex((r) => r.step_index === targetIdx);
  if (rowPos < 0) {
    throw new Error(`Step ${stepIndex} not found in conversation ${conversationId}.`);
  }
  const row = parsed.rows[rowPos];

  const hookLedger = readHookEvents(pluginDataDir, conversationId);
  const hookEvent = hookLedger.postToolByStepIdx.get(targetIdx) || null;
  const tsInfo = parseToolTimestamps(row.content || "");

  let pairedToolCall = null;
  if (row.type === "GENERIC") {
    let genericOffset = 0;
    for (let j = rowPos - 1; j >= 0; j--) {
      const prev = parsed.rows[j];
      if (prev.type === "USER_INPUT") break;
      if (prev.type === "GENERIC") {
        genericOffset++;
      } else if (prev.type === "PLANNER_RESPONSE") {
        const tc = Array.isArray(prev.tool_calls) ? prev.tool_calls[genericOffset] : null;
        if (tc) {
          pairedToolCall = {
            plannerStepIndex: prev.step_index,
            name: tc.name || hookEvent?.name || "unknown",
            args: tc.args ?? hookEvent?.argsPreview ?? null,
          };
        }
        break;
      }
    }
  }

  // Check if any tool_call args or content references an external artifact
  const extFromContent = extractFileRefs(null, null, row.content || "").externalArtifact;
  const artifactPath = findExternalArtifact(sessionPaths, targetIdx, extFromContent);

  let externalOutput = null;
  if (artifactPath && fs.existsSync(artifactPath)) {
    try {
      const st = fs.statSync(artifactPath);
      const safeOffset = Math.max(0, Math.min(st.size, Number(artifactOffset) || 0));
      const safeLimit = Math.max(1024, Math.min(131072, Number(artifactLimit) || 32768));
      const toRead = Math.min(safeLimit, Math.max(0, st.size - safeOffset));
      let chunkText = "";
      if (toRead > 0) {
        const fd = fs.openSync(artifactPath, "r");
        try {
          const buf = Buffer.allocUnsafe(toRead);
          const n = fs.readSync(fd, buf, 0, toRead, safeOffset);
          chunkText = buf.subarray(0, n).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
      externalOutput = {
        filePath: artifactPath,
        totalBytes: st.size,
        offset: safeOffset,
        limit: safeLimit,
        hasMore: safeOffset + toRead < st.size,
        text: chunkText,
      };
    } catch {
      externalOutput = null;
    }
  }

  return {
    conversationId,
    stepIndex: targetIdx,
    type: row.type,
    source: row.source || null,
    status: row.status || null,
    createdAt: row.created_at || null,
    completedAt: tsInfo.completedAt,
    durationMs: tsInfo.durationMs,
    model: row.model || null,
    inputTokens: nonNegInt(row.input_tokens),
    outputTokens: nonNegInt(row.output_tokens),
    cacheReadTokens: nonNegInt(row.cache_read_tokens),
    thinking: typeof row.thinking === "string" ? row.thinking : "",
    content: typeof row.content === "string" ? row.content : "",
    error: row.error
      ? String(row.error)
      : hookEvent?.error ||
        (row.type === "GENERIC" ? detectToolError(pairedToolCall?.name || hookEvent?.name || null, row) : null),
    toolCalls: Array.isArray(row.tool_calls) ? row.tool_calls : [],
    pairedToolCall,
    media: Array.isArray(row.media) ? row.media : [],
    truncatedFields: Array.isArray(row.truncated_fields) ? row.truncated_fields : [],
    hookEvent,
    externalOutput,
    rawStep: row,
  };
}

export function searchTrajectory(
  conversationId,
  {
    query = "",
    regex = false,
    stepTypes = null,
    toolName = null,
    errorsOnly = false,
    limit = 50,
    brainRoots,
    pluginDataDir = getPluginDataDir(),
  } = {}
) {
  const roots = brainRoots && brainRoots.length > 0 ? brainRoots : discoverBrainRoots(pluginDataDir);
  const sessionPaths = resolveSessionPaths(conversationId, roots);
  if (!sessionPaths) {
    throw new Error(`Conversation ${conversationId} not found.`);
  }

  const parsed = parseJsonlDeduplicated(sessionPaths.transcriptFullPath);
  const typeSet =
    Array.isArray(stepTypes) && stepTypes.length > 0
      ? new Set(stepTypes.map((t) => normalizeStepType(t)))
      : null;

  let matcher = null;
  const qStr = String(query || "").trim();
  if (qStr) {
    if (regex) {
      matcher = new RegExp(qStr, "i");
    } else {
      const lower = qStr.toLowerCase();
      matcher = {
        test: (txt) => txt.toLowerCase().includes(lower),
        findIdx: (txt) => txt.toLowerCase().indexOf(lower),
      };
    }
  }

  const matches = [];
  let turnIndex = 0;
  const maxResults = Math.max(1, Math.min(200, Number(limit) || 50));

  for (const r of parsed.rows) {
    if (r.type === "USER_INPUT") turnIndex++;
    if (typeSet && !typeSet.has(r.type)) continue;

    const toolCalls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    if (toolName && !toolCalls.some((tc) => tc?.name === toolName)) {
      continue;
    }

    const detectedErr =
      r.error ||
      r.status === "ERROR" ||
      r.type === "ERROR_MESSAGE" ||
      (r.type === "GENERIC" && detectToolError(null, r));
    if (errorsOnly && !detectedErr) continue;

    const fields = [];
    if (typeof r.content === "string" && r.content) fields.push(["content", r.content]);
    if (typeof r.thinking === "string" && r.thinking) fields.push(["thinking", r.thinking]);
    if (r.error) fields.push(["error", String(r.error)]);
    if (toolCalls.length > 0) {
      fields.push(["tool_calls", JSON.stringify(toolCalls)]);
    }

    if (!matcher) {
      const primary = fields[0]?.[1] || "";
      matches.push({
        stepIndex: r.step_index,
        turnIndex,
        type: r.type,
        status: r.status || "DONE",
        createdAt: r.created_at || null,
        field: fields[0]?.[0] || "step",
        snippet: previewText(primary, 220).text,
      });
    } else {
      let matchedField = null;
      let snippet = "";
      for (const [fName, fText] of fields) {
        if (regex) {
          const m = matcher.exec(fText);
          if (m) {
            matchedField = fName;
            const start = Math.max(0, m.index - 70);
            const end = Math.min(fText.length, m.index + m[0].length + 140);
            snippet = (start > 0 ? "…" : "") + fText.slice(start, end) + (end < fText.length ? "…" : "");
            break;
          }
        } else if (matcher.test(fText)) {
          matchedField = fName;
          const idx = matcher.findIdx(fText);
          const start = Math.max(0, idx - 70);
          const end = Math.min(fText.length, idx + qStr.length + 140);
          snippet = (start > 0 ? "…" : "") + fText.slice(start, end) + (end < fText.length ? "…" : "");
          break;
        }
      }
      if (matchedField) {
        matches.push({
          stepIndex: r.step_index,
          turnIndex,
          type: r.type,
          status: r.status || "DONE",
          createdAt: r.created_at || null,
          field: matchedField,
          snippet,
        });
      }
    }

    if (matches.length >= maxResults) break;
  }

  return {
    conversationId,
    query: qStr,
    totalMatches: matches.length,
    matches,
  };
}

export function buildForkHandoff(
  conversationId,
  upToStepIndex,
  {
    mode = "balanced",
    brainRoots,
    pluginDataDir = getPluginDataDir(),
  } = {}
) {
  const traj = parseTrajectory(conversationId, {
    brainRoots,
    pluginDataDir,
    previewChars: 300,
    includeSubagentTree: false,
  });

  const maxIdx =
    typeof upToStepIndex === "number" && upToStepIndex >= 0
      ? upToStepIndex
      : traj.steps[traj.steps.length - 1]?.stepIndex ?? 0;

  const userGoals = [];
  const actions = [];
  const errors = [];
  const files = new Set();
  let lastReply = "";

  for (const t of traj.turns) {
    if (t.userStepIndex !== null && t.userStepIndex <= maxIdx && t.userGoal) {
      userGoals.push(`Turn ${t.turnIndex}: ${t.userGoal}`);
    }
    for (const inv of t.invocations) {
      if (inv.stepIndex > maxIdx) continue;
      if (inv.replyPreview) lastReply = inv.replyPreview;
      for (const tc of inv.toolCalls) {
        const sIdx = tc.stepIndex ?? inv.stepIndex;
        if (sIdx > maxIdx) continue;
        actions.push(`#${sIdx} ${tc.name}(${tc.argsSummary})`);
        for (const f of tc.fileRefs || []) files.add(f);
        if (tc.error) errors.push(`#${sIdx} ${tc.name}: ${tc.error}`);
      }
    }
  }

  const maxActions = mode === "compact" ? 8 : 20;
  const recentActions = actions.slice(-maxActions);
  const fileList = Array.from(files).slice(0, mode === "compact" ? 10 : 25);

  const lines = [
    `[Trajectory Lens Handoff Branch from ${conversationId} @ Step #${maxIdx}]`,
    "",
    "## Original Goal(s)",
    ...(userGoals.length > 0 ? userGoals.slice(-4).map((g) => `- ${g}`) : [`- ${traj.meta.title}`]),
    "",
    "## Verified Progress & Actions Up To Checkpoint",
    ...(recentActions.length > 0 ? recentActions.map((a) => `- ${a}`) : ["- (No tool actions before this step)"]),
  ];

  if (fileList.length > 0) {
    lines.push("", "## Key Files Touched", ...fileList.map((f) => `- \`${f}\``));
  }
  if (errors.length > 0) {
    lines.push("", "## Errors Observed Before Branch", ...errors.slice(-6).map((e) => `- ${e}`));
  }
  if (lastReply) {
    lines.push("", "## Latest Model State / Output", lastReply);
  }
  lines.push(
    "",
    "## Continue From Here",
    "Please continue from the checkpoint above. Review the current workspace state if needed and await or confirm the next direction."
  );

  return {
    sourceConversationId: conversationId,
    upToStepIndex: maxIdx,
    mode,
    prompt: lines.join("\n"),
  };
}
