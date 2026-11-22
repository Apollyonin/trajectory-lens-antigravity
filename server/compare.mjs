import { parseTrajectory } from "./parser.mjs";

function metricRow(key, labelZh, labelEn, leftVal, rightVal, unit = "") {
  const l = typeof leftVal === "number" ? leftVal : 0;
  const r = typeof rightVal === "number" ? rightVal : 0;
  const delta = r - l;
  const pct = l > 0 ? ((delta / l) * 100) : null;
  return {
    key,
    labelZh,
    labelEn,
    left: leftVal,
    right: rightVal,
    delta,
    deltaPct: pct !== null ? Number(pct.toFixed(1)) : null,
    unit,
  };
}

function summarizeSessionCompact(traj) {
  return {
    conversationId: traj.meta.conversationId,
    title: traj.meta.title,
    surface: traj.meta.surface,
    model: traj.meta.model,
    startedAt: traj.meta.startedAt,
    durationMs: traj.meta.durationMs,
    turnCount: traj.meta.turnCount,
    stepCount: traj.meta.stepCount,
    invocationCount: traj.meta.invocationCount,
    toolCallCount: traj.meta.toolCallCount,
    errorCount: traj.meta.errorCount,
    compactionCount: traj.meta.compactionCount,
    subagentCount: traj.meta.subagentCount,
    totalInputTokens: traj.tokenSummary.totalInputTokens,
    totalOutputTokens: traj.tokenSummary.totalOutputTokens,
    totalCacheReadTokens: traj.tokenSummary.totalCacheReadTokens,
    peakContextTokens: traj.tokenSummary.peakContextTokens,
    avgCacheHitRate: traj.tokenSummary.avgCacheHitRate,
    categoryCounts: traj.analytics.categoryCounts,
    toolCounts: traj.analytics.toolCounts,
    contextSeries: traj.tokenSummary.perInvocationSeries.map((p, idx) => ({
      idx: idx + 1,
      stepIndex: p.stepIndex,
      contextTokens: p.contextTokens,
      cacheHitRate: p.cacheHitRate,
    })),
  };
}

/**
 * Compares two Antigravity sessions side-by-side (DSH trace-compare equivalent).
 */
export function compareSessions(leftId, rightId, ctx = {}) {
  const leftTraj = parseTrajectory(leftId, {
    ...ctx,
    previewChars: 140,
    includeSubagentTree: false,
  });
  const rightTraj = parseTrajectory(rightId, {
    ...ctx,
    previewChars: 140,
    includeSubagentTree: false,
  });

  const left = summarizeSessionCompact(leftTraj);
  const right = summarizeSessionCompact(rightTraj);

  const metrics = [
    metricRow("turns", "对话轮次", "Turns", left.turnCount, right.turnCount),
    metricRow("steps", "总步骤数", "Steps", left.stepCount, right.stepCount),
    metricRow("invocations", "推理次数", "Invocations", left.invocationCount, right.invocationCount),
    metricRow("toolCalls", "工具调用", "Tool Calls", left.toolCallCount, right.toolCallCount),
    metricRow("errors", "错误/异常", "Errors", left.errorCount, right.errorCount),
    metricRow("compactions", "压缩检查点", "Compactions", left.compactionCount, right.compactionCount),
    metricRow("subagents", "子智能体", "Subagents", left.subagentCount, right.subagentCount),
    metricRow("peakContext", "峰值上下文", "Peak Context", left.peakContextTokens, right.peakContextTokens, "tok"),
    metricRow("inputTokens", "新增输入 Token", "Input Tokens", left.totalInputTokens, right.totalInputTokens, "tok"),
    metricRow("outputTokens", "输出 Token", "Output Tokens", left.totalOutputTokens, right.totalOutputTokens, "tok"),
    metricRow(
      "cacheHitPct",
      "缓存命中率",
      "Cache Hit %",
      Number((left.avgCacheHitRate * 100).toFixed(1)),
      Number((right.avgCacheHitRate * 100).toFixed(1)),
      "%"
    ),
    metricRow(
      "durationSec",
      "总耗时",
      "Duration",
      left.durationMs !== null ? Number((left.durationMs / 1000).toFixed(1)) : 0,
      right.durationMs !== null ? Number((right.durationMs / 1000).toFixed(1)) : 0,
      "s"
    ),
  ];

  const categories = ["explore", "edit", "execute", "agent", "mcp", "other"];
  const categoryDiff = categories.map((cat) => ({
    category: cat,
    left: left.categoryCounts[cat] || 0,
    right: right.categoryCounts[cat] || 0,
  }));

  const allToolNames = new Set([
    ...Object.keys(left.toolCounts || {}),
    ...Object.keys(right.toolCounts || {}),
  ]);
  const toolDiff = Array.from(allToolNames)
    .map((name) => {
      const l = left.toolCounts[name] || 0;
      const r = right.toolCounts[name] || 0;
      return { name, left: l, right: r, delta: r - l, total: l + r };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.total - a.total)
    .slice(0, 16);

  return {
    left,
    right,
    metrics,
    categoryDiff,
    toolDiff,
  };
}
