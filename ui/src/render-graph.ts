import { t } from "./i18n.ts";
import type { DagEdge, DagNode, Lang, TrajectoryData } from "./types.ts";
import { esc, fmtMs, fmtNum } from "./utils.ts";

export interface GraphViewState {
  lang: Lang;
  orientation: "LR" | "TB";
  turnFilter: number | "all";
  categoryFilter: string;
  selectedStepIndex: number | null;
  zoom: number;
  panX: number;
  panY: number;
}

const NODE_W = 166;
const NODE_H = 54;
const GAP_MAIN = 58;
const GAP_CROSS = 24;

function nodeColor(node: DagNode): { stroke: string; badge: string } {
  if (node.status === "ERROR" || node.kind === "error") {
    return { stroke: "#f85149", badge: "#f85149" };
  }
  if (node.kind === "user") return { stroke: "#3b82f6", badge: "#3b82f6" };
  if (node.kind === "planner" || node.kind === "reply") return { stroke: "#6366f1", badge: "#6366f1" };
  if (node.kind === "checkpoint") return { stroke: "#f59e0b", badge: "#f59e0b" };
  if (node.kind === "subagent") return { stroke: "#ec4899", badge: "#ec4899" };
  switch (node.category) {
    case "explore":
      return { stroke: "#3b82f6", badge: "#3b82f6" };
    case "edit":
      return { stroke: "#10b981", badge: "#10b981" };
    case "execute":
      return { stroke: "#f59e0b", badge: "#f59e0b" };
    case "agent":
      return { stroke: "#8b5cf6", badge: "#8b5cf6" };
    case "mcp":
      return { stroke: "#06b6d4", badge: "#06b6d4" };
    default:
      return { stroke: "#64748b", badge: "#64748b" };
  }
}

export function computeDagLayout(
  rawNodes: DagNode[],
  rawEdges: DagEdge[],
  orientation: "LR" | "TB",
  turnFilter: number | "all",
  categoryFilter: string
) {
  const nodes = rawNodes.filter((n) => {
    if (turnFilter !== "all" && n.turnIndex !== turnFilter) return false;
    if (categoryFilter !== "all") {
      if (categoryFilter === "error") return n.status === "ERROR" || n.kind === "error";
      if (n.kind === "tool" || n.kind === "subagent") return n.category === categoryFilter;
    }
    return true;
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  if (nodes.length === 0) {
    return { positioned: [], edges: [], width: 640, height: 320 };
  }

  // Topological longest-path rank
  const rankMap = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    rankMap.set(n.id, 0);
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, d] of indeg.entries()) {
    if (d === 0) queue.push(id);
  }
  let guard = 0;
  while (queue.length > 0 && guard++ < nodes.length * 4) {
    const u = queue.shift()!;
    const r = rankMap.get(u) || 0;
    for (const v of adj.get(u) || []) {
      if ((rankMap.get(v) || 0) < r + 1) {
        rankMap.set(v, r + 1);
      }
      const nextIn = (indeg.get(v) || 1) - 1;
      indeg.set(v, nextIn);
      if (nextIn <= 0) queue.push(v);
    }
  }

  // Group nodes by rank
  const byRank = new Map<number, DagNode[]>();
  let maxRank = 0;
  for (const n of nodes) {
    const r = rankMap.get(n.id) || 0;
    if (r > maxRank) maxRank = r;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }

  let maxLaneSize = 1;
  for (const arr of byRank.values()) {
    arr.sort((a, b) => (a.parallelIndex ?? a.stepIndex) - (b.parallelIndex ?? b.stepIndex));
    if (arr.length > maxLaneSize) maxLaneSize = arr.length;
  }

  const positioned: Array<{ node: DagNode; x: number; y: number }> = [];
  const posMap = new Map<string, { x: number; y: number }>();

  const crossSpan = maxLaneSize * ((orientation === "LR" ? NODE_H : NODE_W) + GAP_CROSS);

  for (let r = 0; r <= maxRank; r++) {
    const arr = byRank.get(r) || [];
    const totalCross = arr.length * (orientation === "LR" ? NODE_H : NODE_W) + Math.max(0, arr.length - 1) * GAP_CROSS;
    const startCross = Math.max(24, (crossSpan - totalCross) / 2 + 24);

    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      let x = 24;
      let y = 24;
      if (orientation === "LR") {
        x = 24 + r * (NODE_W + GAP_MAIN);
        y = startCross + i * (NODE_H + GAP_CROSS);
      } else {
        x = startCross + i * (NODE_W + GAP_CROSS);
        y = 24 + r * (NODE_H + GAP_MAIN);
      }
      positioned.push({ node: n, x, y });
      posMap.set(n.id, { x, y });
    }
  }

  const width =
    orientation === "LR"
      ? Math.max(640, (maxRank + 1) * (NODE_W + GAP_MAIN) + 60)
      : Math.max(640, crossSpan + 60);
  const height =
    orientation === "LR"
      ? Math.max(360, crossSpan + 60)
      : Math.max(360, (maxRank + 1) * (NODE_H + GAP_MAIN) + 60);

  return { positioned, posMap, edges, width, height };
}

export function renderGraphHtml(traj: TrajectoryData, state: GraphViewState): string {
  const { lang, orientation, turnFilter, categoryFilter, selectedStepIndex } = state;
  const layout = computeDagLayout(
    traj.dag.nodes,
    traj.dag.edges,
    orientation,
    turnFilter,
    categoryFilter
  );

  const turnOptions = [
    `<option value="all" ${turnFilter === "all" ? "selected" : ""}>${esc(t(lang, "graphAllTurns"))} (${traj.turns.length})</option>`,
    ...traj.turns.map(
      (trn) =>
        `<option value="${trn.turnIndex}" ${turnFilter === trn.turnIndex ? "selected" : ""}>Turn ${trn.turnIndex}: ${esc((trn.userGoal || "Bootstrap").slice(0, 38))}</option>`
    ),
  ].join("");

  const categories = ["all", "explore", "edit", "execute", "agent", "mcp", "error"];
  const catOptions = categories
    .map(
      (c) =>
        `<option value="${c}" ${categoryFilter === c ? "selected" : ""}>${esc(c.toUpperCase())}</option>`
    )
    .join("");

  const edgesSvg = layout.edges
    .map((e) => {
      const p1 = layout.posMap?.get(e.from);
      const p2 = layout.posMap?.get(e.to);
      if (!p1 || !p2) return "";
      let d = "";
      if (orientation === "LR") {
        const x1 = p1.x + NODE_W;
        const y1 = p1.y + NODE_H / 2;
        const x2 = p2.x;
        const y2 = p2.y + NODE_H / 2;
        const dx = Math.max(24, (x2 - x1) * 0.5);
        d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else {
        const x1 = p1.x + NODE_W / 2;
        const y1 = p1.y + NODE_H;
        const x2 = p2.x + NODE_W / 2;
        const y2 = p2.y;
        const dy = Math.max(24, (y2 - y1) * 0.5);
        d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
      }
      const stroke =
        e.kind === "parallel"
          ? "#8b5cf6"
          : e.kind === "join"
          ? "#06b6d4"
          : e.kind === "system"
          ? "#f59e0b"
          : "#64748b";
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="0.7" stroke-width="1.8" marker-end="url(#tl-arrow)" />`;
    })
    .join("");

  const nodesSvg = layout.positioned
    .map(({ node, x, y }) => {
      const c = nodeColor(node);
      const isSelected = selectedStepIndex === node.stepIndex;
      const metricText =
        node.durationMs !== null
          ? fmtMs(node.durationMs)
          : node.tokens
          ? `${fmtNum(node.tokens)}t`
          : `T${node.turnIndex}`;

      return `
        <g class="tl-dag-node" data-step="${node.stepIndex}" transform="translate(${x}, ${y})" style="cursor:pointer">
          <rect width="${NODE_W}" height="${NODE_H}" rx="8" ry="8"
                fill="var(--tl-bg)" stroke="${isSelected ? "var(--tl-ring)" : c.stroke}"
                stroke-width="${isSelected ? "3" : "1.7"}" />
          <rect x="0" y="0" width="6" height="${NODE_H}" rx="3" fill="${c.badge}" />
          <text x="14" y="18" font-size="11" font-weight="700" fill="var(--tl-fg)">${esc(node.label.slice(0, 22))}</text>
          <text x="${NODE_W - 8}" y="18" text-anchor="end" font-size="10" fill="var(--tl-fg2)">${esc(metricText)}</text>
          <text x="14" y="38" font-size="10" fill="var(--tl-fg2)">#${node.stepIndex} ${esc((node.sublabel || node.kind).slice(0, 22))}</text>
        </g>
      `;
    })
    .join("");

  return `
    <div class="tl-toolbar">
      <select id="tl-graph-turn" class="tl-session-select">${turnOptions}</select>
      <select id="tl-graph-cat" class="tl-btn">${catOptions}</select>
      <button class="tl-btn ${orientation === "LR" ? "active" : ""}" data-graph-orient="LR">${esc(t(lang, "graphLR"))}</button>
      <button class="tl-btn ${orientation === "TB" ? "active" : ""}" data-graph-orient="TB">${esc(t(lang, "graphTB"))}</button>
      <button class="tl-btn" data-graph-zoom="in">+</button>
      <button class="tl-btn" data-graph-zoom="out">-</button>
      <button class="tl-btn" data-graph-zoom="fit">${esc(t(lang, "graphFit"))}</button>
      <span class="tl-muted">${layout.positioned.length} nodes · ${layout.edges.length} edges</span>
    </div>
    <div class="tl-graph-wrap">
      <svg id="tl-graph-svg" class="tl-graph-svg" viewBox="0 0 ${layout.width} ${layout.height}">
        <defs>
          <marker id="tl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
          </marker>
        </defs>
        <g id="tl-graph-viewport" transform="translate(${state.panX}, ${state.panY}) scale(${state.zoom})">
          ${edgesSvg}
          ${nodesSvg}
        </g>
      </svg>
    </div>
  `;
}
