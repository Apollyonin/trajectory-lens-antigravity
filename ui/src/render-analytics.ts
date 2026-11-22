import { t } from "./i18n.ts";
import type { Lang, TrajectoryData } from "./types.ts";
import { esc, fmtMs, fmtNum, toFileUri } from "./utils.ts";

function renderContextSvg(traj: TrajectoryData): string {
  const series = traj.tokenSummary.perInvocationSeries;
  if (!series || series.length === 0) {
    return `<div class="tl-muted">No token telemetry points in this transcript.</div>`;
  }

  const W = 680;
  const H = 200;
  const padL = 52;
  const padR = 44;
  const padT = 18;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxCtx = Math.max(1000, ...series.map((p) => p.contextTokens));
  const stepX = series.length > 1 ? innerW / (series.length - 1) : innerW;

  const xAt = (i: number) => (series.length === 1 ? padL + innerW / 2 : padL + i * stepX);
  const yCtx = (v: number) => padT + innerH - (v / maxCtx) * innerH;
  const yPct = (r: number) => padT + innerH - Math.max(0, Math.min(1, r)) * innerH;

  const totalLinePts = series.map((p, i) => `${xAt(i).toFixed(1)},${yCtx(p.contextTokens).toFixed(1)}`).join(" ");
  const cacheLinePts = series.map((p, i) => `${xAt(i).toFixed(1)},${yCtx(p.cacheReadTokens).toFixed(1)}`).join(" ");
  const hitLinePts = series.map((p, i) => `${xAt(i).toFixed(1)},${yPct(p.cacheHitRate).toFixed(1)}`).join(" ");

  const areaTotal =
    `${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} ` +
    totalLinePts +
    ` ${xAt(series.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)}`;

  const checkpoints = traj.analytics.checkpoints || [];
  const cpMarkers = checkpoints
    .map((cp) => {
      let nearestIdx = series.findIndex((p) => p.stepIndex >= cp.stepIndex);
      if (nearestIdx < 0) nearestIdx = series.length - 1;
      const cx = xAt(nearestIdx);
      return `<line x1="${cx}" y1="${padT}" x2="${cx}" y2="${padT + innerH}" stroke="#f59e0b" stroke-dasharray="4 3" stroke-width="1.5" />`;
    })
    .join("");

  const dots = series
    .map((p, i) => {
      const cx = xAt(i);
      const cy = yCtx(p.contextTokens);
      return `<circle cx="${cx}" cy="${cy}" r="3.2" fill="var(--tl-info)" data-step="${p.stepIndex}" style="cursor:pointer"><title>Step #${p.stepIndex}: ctx=${p.contextTokens.toLocaleString()} (cache=${(p.cacheHitRate * 100).toFixed(1)}%)</title></circle>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--tl-border)" />
      <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--tl-border)" />
      <text x="${padL - 6}" y="${padT + 8}" text-anchor="end" font-size="10" fill="var(--tl-fg2)">${fmtNum(maxCtx)}</text>
      <text x="${padL - 6}" y="${padT + innerH}" text-anchor="end" font-size="10" fill="var(--tl-fg2)">0</text>
      <text x="${W - padR + 6}" y="${padT + 8}" font-size="10" fill="#10b981">100%</text>
      <text x="${W - padR + 6}" y="${padT + innerH}" font-size="10" fill="#10b981">0%</text>
      <polygon points="${areaTotal}" fill="var(--tl-info)" fill-opacity="0.14" />
      <polyline points="${totalLinePts}" fill="none" stroke="var(--tl-info)" stroke-width="2" />
      <polyline points="${cacheLinePts}" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="3 2" />
      <polyline points="${hitLinePts}" fill="none" stroke="#10b981" stroke-width="1.6" />
      ${cpMarkers}
      ${dots}
      <text x="${padL}" y="${H - 6}" font-size="10" fill="var(--tl-fg2)">■ Context (blue)  ⋯ Cache Read (purple)  ─ Hit % (green)  ┆ Compaction (amber)</text>
    </svg>
  `;
}

export function renderAnalyticsHtml(traj: TrajectoryData, lang: Lang): string {
  const insights = traj.analytics.insights || [];
  const catEntries = Object.entries(traj.analytics.categoryCounts || {}).sort((a, b) => b[1] - a[1]);
  const totalTools = Math.max(1, catEntries.reduce((a, [, v]) => a + v, 0));

  const insightHtml =
    insights.length > 0
      ? insights
          .map((ins) => {
            const cls = ins.severity === "warning" ? "warn" : ins.severity === "success" ? "ok" : "info";
            const chips = (ins.stepIndices || [])
              .slice(0, 6)
              .map(
                (idx) =>
                  `<button class="tl-chip" data-step="${idx}">#${idx}</button>`
              )
              .join("");
            return `
              <div class="tl-card" style="margin-bottom:8px">
                <div class="tl-step-top">
                  <strong>${esc(lang === "zh" ? ins.titleZh : ins.titleEn)}</strong>
                  <span class="tl-pill ${cls}">${esc(ins.kind)}</span>
                </div>
                <div class="tl-muted" style="margin:4px 0 6px">${esc(lang === "zh" ? ins.detailZh : ins.detailEn)}</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap">${chips}</div>
              </div>
            `;
          })
          .join("")
      : `<div class="tl-muted">${esc(t(lang, "noInsights"))}</div>`;

  const catHtml =
    catEntries.length > 0
      ? catEntries
          .map(([cat, cnt]) => {
            const pct = ((cnt / totalTools) * 100).toFixed(1);
            return `
              <div style="margin-bottom:8px">
                <div class="tl-step-top">
                  <span><strong>${esc(cat.toUpperCase())}</strong></span>
                  <span class="tl-muted">${cnt} (${pct}%)</span>
                </div>
                <div class="tl-bar-track"><div class="tl-bar-fill" style="width:${pct}%"></div></div>
              </div>
            `;
          })
          .join("")
      : `<div class="tl-muted">No tool calls recorded.</div>`;

  const slowestHtml =
    traj.analytics.slowestSteps.length > 0
      ? `<table class="tl-table">
          <thead><tr><th>Step</th><th>Tool</th><th>Category</th><th>Duration</th><th>Args</th></tr></thead>
          <tbody>
            ${traj.analytics.slowestSteps
              .map(
                (s) => `
                  <tr data-step="${s.stepIndex}" style="cursor:pointer">
                    <td class="tl-mono">#${s.stepIndex}</td>
                    <td><strong>${esc(s.name)}</strong></td>
                    <td><span class="tl-pill">${esc(s.category)}</span></td>
                    <td>${fmtMs(s.durationMs)}</td>
                    <td class="tl-muted tl-mono">${esc((s.argsSummary || "").slice(0, 48))}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>`
      : `<div class="tl-muted">No timed tool steps.</div>`;

  const filesHtml =
    traj.analytics.fileTouchCounts.length > 0
      ? `<table class="tl-table">
          <thead><tr><th>File</th><th>Touches</th><th></th></tr></thead>
          <tbody>
            ${traj.analytics.fileTouchCounts
              .map((f) => {
                const uri = toFileUri(f.filePath);
                return `
                  <tr>
                    <td class="tl-mono" style="word-break:break-all">${esc(f.filePath)}</td>
                    <td>${f.count}</td>
                    <td>${uri ? `<button class="tl-btn" style="padding:2px 6px" data-open-file="${esc(uri)}">Open</button>` : ""}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>`
      : `<div class="tl-muted">No workspace file references extracted.</div>`;

  return `
    <div class="tl-card">
      <div class="tl-card-hd">${esc(t(lang, "insightsTitle"))}</div>
      ${insightHtml}
    </div>
    <div class="tl-card">
      <div class="tl-card-hd">${esc(t(lang, "ctxChartTitle"))}</div>
      ${renderContextSvg(traj)}
    </div>
    <div class="tl-card">
      <div class="tl-card-hd">${esc(t(lang, "catChartTitle"))}</div>
      ${catHtml}
    </div>
    <div class="tl-card" style="overflow-x:auto">
      <div class="tl-card-hd">${esc(t(lang, "slowestTitle"))}</div>
      ${slowestHtml}
    </div>
    <div class="tl-card" style="overflow-x:auto">
      <div class="tl-card-hd">${esc(t(lang, "filesTitle"))}</div>
      ${filesHtml}
    </div>
  `;
}
