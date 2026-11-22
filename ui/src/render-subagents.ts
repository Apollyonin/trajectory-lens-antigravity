import { t } from "./i18n.ts";
import type { Lang, SubagentNode, TrajectoryData } from "./types.ts";
import { esc, fmtMs, fmtNum } from "./utils.ts";

interface FlatSubagentRow {
  depth: number;
  node: SubagentNode;
}

function flattenTree(node: SubagentNode | null, depth = 0, out: FlatSubagentRow[] = []): FlatSubagentRow[] {
  if (!node) return out;
  out.push({ depth, node });
  for (const ch of node.children || []) {
    flattenTree(ch, depth + 1, out);
  }
  return out;
}

export function renderSubagentsHtml(
  traj: TrajectoryData,
  lang: Lang,
  breadcrumbStack: Array<{ conversationId: string; title: string }>
): string {
  const tree = traj.subagentTree;
  const rows = flattenTree(tree);

  const crumbHtml =
    breadcrumbStack.length > 0
      ? `<div class="tl-toolbar">
           <button class="tl-btn" data-subagent-back="1">← ${esc(t(lang, "backToParent"))}</button>
           <span class="tl-muted">${breadcrumbStack.map((b) => esc(b.title.slice(0, 28))).join(" › ")} › <strong>${esc(traj.meta.title.slice(0, 32))}</strong></span>
         </div>`
      : "";

  if (!tree || rows.length <= 1) {
    return `
      ${crumbHtml}
      <div class="tl-card">
        <div class="tl-muted">${esc(t(lang, "subagentNone"))}</div>
      </div>
    `;
  }

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const r of rows) {
    const s = r.node.startedAt ? Date.parse(r.node.startedAt) : NaN;
    const e = r.node.endedAt ? Date.parse(r.node.endedAt) : NaN;
    if (Number.isFinite(s)) minTs = Math.min(minTs, s);
    if (Number.isFinite(e)) maxTs = Math.max(maxTs, e);
  }
  const spanTotal = Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs > minTs ? maxTs - minTs : 1;

  const waterfallHtml = rows
    .map(({ depth, node }) => {
      const s = node.startedAt ? Date.parse(node.startedAt) : minTs;
      const e = node.endedAt ? Date.parse(node.endedAt) : s;
      const leftPct = Number.isFinite(s) && Number.isFinite(minTs) ? Math.max(0, Math.min(96, ((s - minTs) / spanTotal) * 100)) : 0;
      const widthPct =
        Number.isFinite(s) && Number.isFinite(e) && spanTotal > 0
          ? Math.max(2, Math.min(100 - leftPct, ((e - s) / spanTotal) * 100))
          : 4;
      const isRoot = depth === 0;
      const barColor =
        node.errorCount > 0 ? "var(--tl-err)" : isRoot ? "var(--tl-info)" : "#8b5cf6";

      return `
        <div class="tl-waterfall-row">
          <div style="padding-left:${depth * 14}px;min-width:0">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(node.role)}</div>
            <div class="tl-muted tl-mono" style="font-size:10.5px">${esc(node.typeName)} · ${esc(node.conversationId.slice(0, 8))}</div>
          </div>
          <div class="tl-wf-track" title="${esc(node.role)} (${fmtMs(node.durationMs)})">
            <div class="tl-wf-bar" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%;background:${barColor}"></div>
          </div>
          <div style="text-align:right;font-size:11px">
            <div>${fmtMs(node.durationMs)}</div>
            ${
              !isRoot && node.status !== "MISSING_TRANSCRIPT"
                ? `<button class="tl-btn" style="padding:2px 6px;font-size:10.5px;margin-top:2px" data-drill-subagent="${esc(node.conversationId)}">${esc(t(lang, "drillDown"))}</button>`
                : ""
            }
          </div>
        </div>
      `;
    })
    .join("");

  const tableRows = rows
    .map(
      ({ depth, node }) => `
        <tr>
          <td style="padding-left:${depth * 14 + 8}px"><strong>${esc(node.role)}</strong> <span class="tl-muted">(${esc(node.typeName)})</span></td>
          <td class="tl-mono">${esc(node.model || "—")}</td>
          <td>${node.spawnStepIndex !== null ? `#${node.spawnStepIndex}` : "—"}</td>
          <td>${node.stepCount}</td>
          <td>${node.toolCallCount}</td>
          <td>${fmtNum(node.totalTokens)}</td>
          <td>${node.errorCount > 0 ? `<span class="tl-pill err">${node.errorCount}</span>` : "0"}</td>
          <td>${fmtMs(node.durationMs)}</td>
        </tr>
      `
    )
    .join("");

  return `
    ${crumbHtml}
    <div class="tl-card">
      <div class="tl-card-hd">Multi-Agent Span Waterfall (${rows.length} spans)</div>
      ${waterfallHtml}
    </div>
    <div class="tl-card" style="overflow-x:auto">
      <div class="tl-card-hd">Span Metrics</div>
      <table class="tl-table">
        <thead>
          <tr><th>Agent</th><th>Model</th><th>Spawn</th><th>Steps</th><th>Tools</th><th>Tokens</th><th>Errors</th><th>Duration</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
}
