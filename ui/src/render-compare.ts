import { t } from "./i18n.ts";
import type { Lang, SessionSummary } from "./types.ts";
import { esc, fmtNum } from "./utils.ts";

function renderOverlayChart(leftSeries: any[], rightSeries: any[]): string {
  const maxPts = Math.max(leftSeries.length, rightSeries.length);
  if (maxPts === 0) return `<div class="tl-muted">No context curves available.</div>`;

  const W = 640;
  const H = 160;
  const padL = 48;
  const padR = 16;
  const padT = 14;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxCtx = Math.max(
    1000,
    ...leftSeries.map((p) => p.contextTokens || 0),
    ...rightSeries.map((p) => p.contextTokens || 0)
  );
  const toPts = (arr: any[]) =>
    arr
      .map((p, i) => {
        const x = padL + (maxPts > 1 ? (i / (maxPts - 1)) * innerW : innerW / 2);
        const y = padT + innerH - ((p.contextTokens || 0) / maxCtx) * innerH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--tl-border)" />
      <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--tl-border)" />
      <text x="${padL - 6}" y="${padT + 8}" text-anchor="end" font-size="10" fill="var(--tl-fg2)">${fmtNum(maxCtx)}</text>
      <text x="${padL - 6}" y="${padT + innerH}" text-anchor="end" font-size="10" fill="var(--tl-fg2)">0</text>
      ${leftSeries.length ? `<polyline points="${toPts(leftSeries)}" fill="none" stroke="#3b82f6" stroke-width="2" />` : ""}
      ${rightSeries.length ? `<polyline points="${toPts(rightSeries)}" fill="none" stroke="#ec4899" stroke-width="2" />` : ""}
      <text x="${padL}" y="${H - 4}" font-size="10" fill="var(--tl-fg2)">─ Session A (blue)   ─ Session B (pink)</text>
    </svg>
  `;
}

export function renderCompareHtml(
  lang: Lang,
  sessions: SessionSummary[],
  leftId: string,
  rightId: string,
  compareResult: any,
  loading: boolean
): string {
  if (sessions.length < 2) {
    return `<div class="tl-card"><div class="tl-muted">${esc(t(lang, "compareNeedTwo"))}</div></div>`;
  }

  const opts = (selected: string) =>
    sessions
      .map(
        (s) =>
          `<option value="${esc(s.conversationId)}" ${s.conversationId === selected ? "selected" : ""}>${esc(s.title.slice(0, 46))} (${esc(s.conversationId.slice(0, 8))})</option>`
      )
      .join("");

  const controls = `
    <div class="tl-card">
      <div class="tl-toolbar">
        <label>${esc(t(lang, "compareLeft"))}:
          <select id="tl-cmp-left" class="tl-session-select">${opts(leftId)}</select>
        </label>
        <label>${esc(t(lang, "compareRight"))}:
          <select id="tl-cmp-right" class="tl-session-select">${opts(rightId)}</select>
        </label>
        <button class="tl-btn primary" data-run-compare="1" ${loading ? "disabled" : ""}>${esc(t(lang, "compareBtn"))}</button>
      </div>
    </div>
  `;

  if (loading) {
    return `${controls}<div class="tl-card"><div class="tl-muted">${esc(t(lang, "loading"))}</div></div>`;
  }

  if (!compareResult) {
    return controls;
  }

  const rowsHtml = (compareResult.metrics || [])
    .map((m: any) => {
      const sign = m.delta > 0 ? "+" : "";
      const deltaColor =
        m.key === "errors"
          ? m.delta > 0
            ? "var(--tl-err)"
            : m.delta < 0
            ? "var(--tl-ok)"
            : "var(--tl-fg2)"
          : m.key === "cacheHitPct"
          ? m.delta > 0
            ? "var(--tl-ok)"
            : m.delta < 0
            ? "var(--tl-err)"
            : "var(--tl-fg2)"
          : "var(--tl-fg2)";

      return `
        <tr>
          <td><strong>${esc(lang === "zh" ? m.labelZh : m.labelEn)}</strong></td>
          <td class="tl-mono">${esc(m.left)} ${esc(m.unit)}</td>
          <td class="tl-mono">${esc(m.right)} ${esc(m.unit)}</td>
          <td class="tl-mono" style="color:${deltaColor}">${sign}${Number(m.delta.toFixed(1))} ${esc(m.unit)}${m.deltaPct !== null ? ` (${sign}${m.deltaPct}%)` : ""}</td>
        </tr>
      `;
    })
    .join("");

  return `
    ${controls}
    <div class="tl-card">
      <div class="tl-card-hd">Context Curve Overlay</div>
      ${renderOverlayChart(compareResult.left?.contextSeries || [], compareResult.right?.contextSeries || [])}
    </div>
    <div class="tl-card" style="overflow-x:auto">
      <div class="tl-card-hd">Side-by-Side Metrics (A vs B)</div>
      <table class="tl-table">
        <thead>
          <tr><th>Metric</th><th>Session A</th><th>Session B</th><th>Delta (B - A)</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}
