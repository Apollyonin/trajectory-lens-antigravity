import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { t } from "./i18n.ts";
import { renderAnalyticsHtml } from "./render-analytics.ts";
import { renderCompareHtml } from "./render-compare.ts";
import { renderGraphHtml } from "./render-graph.ts";
import { renderInspectorHtml, renderLedgerHtml } from "./render-ledger.ts";
import { renderSubagentsHtml } from "./render-subagents.ts";
import type {
  InspectorSubTab,
  Lang,
  LedgerFilter,
  SessionSummary,
  StepDetailData,
  TabId,
  TrajectoryData,
} from "./types.ts";
import { esc, fmtDateCompact, fmtMs, fmtNum, ToolCallQueue } from "./utils.ts";

const app = new App({ name: "Trajectory Lens", version: "1.0.0" }, {});
const rpcQueue = new ToolCallQueue();

const ToggleAuxPaneResultSchema = z
  .object({
    isError: z.boolean().optional(),
  })
  .passthrough();

let lang: Lang = "zh";
let activeTab: TabId = "ledger";
let plainGuide = false;
let liveFollow = true;
let showScopeInfo = false;
let loading = true;
let statusBanner: { kind: "info" | "ok" | "err"; text: string } | null = null;

let activeConversationId: string | null = null;
let selectedConversationId: string | null = null;
let sessions: SessionSummary[] = [];
let trajectory: TrajectoryData | null = null;
let sessionFilter = "";

// Ledger state
let ledgerSearch = "";
let ledgerFilter: LedgerFilter = "all";
const collapsedTurns = new Set<number>();
let deepSearchResults: { query: string; totalMatches: number; matches: any[] } | null = null;
let deepSearchLoading = false;

// Replay state
let replayOrder: number[] = [];
let replayCursor = 0;
let replayActiveStepIndex: number | null = null;
let replayPlaying = false;
let replaySpeed = 1;
let replayTimer: number | null = null;

// Inspector state
let selectedStepIndex: number | null = null;
let inspectorSubTab: InspectorSubTab = "overview";
let stepDetail: StepDetailData | null = null;
let stepDetailLoading = false;
let forkStatusMsg: string | null = null;
const stepDetailCache = new Map<string, StepDetailData>();

// Graph state
let graphOrientation: "LR" | "TB" = "LR";
let graphTurnFilter: number | "all" = "all";
let graphCategoryFilter = "all";
let graphZoom = 1;
let graphPanX = 0;
let graphPanY = 0;

// Subagent drill-down breadcrumb
const subagentStack: Array<{ conversationId: string; title: string }> = [];

// Compare state
let compareLeftId = "";
let compareRightId = "";
let compareResult: any = null;
let compareLoading = false;

let graphDragState: {
  vpEl: SVGGElement;
  startX: number;
  startY: number;
  basePanX: number;
  basePanY: number;
  moved: number;
} | null = null;
let lastGraphDragMoved = 0;

window.addEventListener(
  "pointermove",
  (ev) => {
    if (!graphDragState) return;
    const dx = ev.clientX - graphDragState.startX;
    const dy = ev.clientY - graphDragState.startY;
    graphDragState.moved = Math.hypot(dx, dy);
    lastGraphDragMoved = graphDragState.moved;
    graphPanX = graphDragState.basePanX + dx;
    graphPanY = graphDragState.basePanY + dy;
    graphDragState.vpEl.setAttribute(
      "transform",
      `translate(${graphPanX}, ${graphPanY}) scale(${graphZoom})`
    );
  },
  { passive: true }
);

window.addEventListener(
  "pointerup",
  () => {
    graphDragState = null;
  },
  { passive: true }
);

function normalizeTab(tab?: string): TabId {
  const valid: TabId[] = ["ledger", "graph", "subagents", "analytics", "compare", "sessions"];
  return valid.includes(tab as TabId) ? (tab as TabId) : "ledger";
}

function rebuildReplayOrder() {
  replayOrder = [];
  if (!trajectory) return;
  for (const s of trajectory.steps || []) {
    if (typeof s.stepIndex === "number") replayOrder.push(s.stepIndex);
  }
  if (replayCursor >= replayOrder.length) replayCursor = 0;
}

function applyHostCtx(ctx: any) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute("data-theme", ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

async function callServer(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return rpcQueue.run(() =>
    app.callServerTool({
      name,
      arguments: args,
    })
  );
}

function stopReplayTimer() {
  if (replayTimer !== null) {
    window.clearInterval(replayTimer);
    replayTimer = null;
  }
  replayPlaying = false;
}

function stepReplay(delta: number) {
  if (replayOrder.length === 0) return;
  if (replayActiveStepIndex === null) {
    replayCursor = delta >= 0 ? 0 : replayOrder.length - 1;
  } else {
    replayCursor = Math.max(0, Math.min(replayOrder.length - 1, replayCursor + delta));
  }
  replayActiveStepIndex = replayOrder[replayCursor];
  render();
  const el = document.querySelector(`[data-step="${replayActiveStepIndex}"]`);
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function toggleReplay() {
  if (replayPlaying) {
    stopReplayTimer();
    render();
    return;
  }
  if (replayOrder.length === 0) return;
  if (replayActiveStepIndex === null || replayCursor >= replayOrder.length - 1) {
    replayCursor = 0;
    replayActiveStepIndex = replayOrder[0];
  }
  replayPlaying = true;
  render();
  replayTimer = window.setInterval(() => {
    if (replayCursor >= replayOrder.length - 1) {
      stopReplayTimer();
      render();
      return;
    }
    stepReplay(1);
  }, Math.max(80, Math.round(700 / replaySpeed)));
}

async function loadSessionsList() {
  try {
    const res = await callServer("app_list_sessions", { limit: 60 });
    const sc = res?.structuredContent as any;
    if (Array.isArray(sc?.sessions)) {
      sessions = sc.sessions;
      if (sc.activeConversationId) activeConversationId = sc.activeConversationId;
      if (!compareLeftId && sessions.length >= 1) compareLeftId = sessions[0].conversationId;
      if (!compareRightId && sessions.length >= 2) compareRightId = sessions[1].conversationId;
    }
  } catch {
    // non-fatal
  }
}

async function loadTrajectory(conversationId?: string | null, silent = false) {
  if (!silent) {
    loading = true;
    render();
  }
  try {
    const res = await callServer("app_load_trajectory", {
      ...(conversationId ? { conversationId } : {}),
      includeSubagentTree: true,
    });
    const sc = res?.structuredContent as any;
    if (sc?.trajectory) {
      trajectory = sc.trajectory as TrajectoryData;
      selectedConversationId = trajectory.meta.conversationId;
      rebuildReplayOrder();
      if (!silent) {
        selectedStepIndex = null;
        stepDetail = null;
        forkStatusMsg = null;
        deepSearchResults = null;
        graphTurnFilter = "all";
        graphZoom = 1;
        graphPanX = 0;
        graphPanY = 0;
      }
    } else if (sc?.error && !silent) {
      statusBanner = { kind: "err", text: String(sc.error) };
    }
  } catch (err) {
    if (!silent) {
      statusBanner = {
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    loading = false;
    render();
  }
}

async function selectStep(stepIndex: number, artifactOffset = 0, appendArtifact = false) {
  if (!trajectory) return;
  const convId = trajectory.meta.conversationId;
  selectedStepIndex = stepIndex;
  forkStatusMsg = null;

  const cacheKey = `${convId}:${trajectory.meta.revision}:${stepIndex}`;
  if (!appendArtifact && artifactOffset === 0 && stepDetailCache.has(cacheKey)) {
    stepDetail = stepDetailCache.get(cacheKey)!;
    stepDetailLoading = false;
    render();
    return;
  }

  stepDetailLoading = true;
  render();

  try {
    const res = await callServer("app_get_step_detail", {
      conversationId: convId,
      stepIndex,
      artifactOffset,
      artifactLimit: 32768,
    });
    const sc = res?.structuredContent as StepDetailData | undefined;
    if (sc) {
      if (appendArtifact && stepDetail && stepDetail.externalOutput && sc.externalOutput) {
        sc.externalOutput.text = stepDetail.externalOutput.text + sc.externalOutput.text;
        sc.externalOutput.offset = 0;
      }
      stepDetail = sc;
      if (artifactOffset === 0) {
        stepDetailCache.set(cacheKey, sc);
      }
    }
  } catch (err) {
    statusBanner = {
      kind: "err",
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    stepDetailLoading = false;
    render();
  }
}

async function runDeepSearch() {
  if (!trajectory) return;
  const q = ledgerSearch.trim();
  const errorsOnly = ledgerFilter === "errors";
  if (!q && !errorsOnly) return;
  deepSearchLoading = true;
  render();
  try {
    const res = await callServer("app_search_trajectory", {
      conversationId: trajectory.meta.conversationId,
      query: q,
      errorsOnly,
      limit: 60,
    });
    deepSearchResults = (res?.structuredContent as any) || null;
  } catch (err) {
    statusBanner = { kind: "err", text: err instanceof Error ? err.message : String(err) };
  } finally {
    deepSearchLoading = false;
    render();
  }
}

async function runCompare() {
  if (!compareLeftId || !compareRightId) return;
  compareLoading = true;
  render();
  try {
    const res = await callServer("app_compare_sessions", {
      leftConversationId: compareLeftId,
      rightConversationId: compareRightId,
    });
    compareResult = res?.structuredContent || null;
  } catch (err) {
    statusBanner = { kind: "err", text: err instanceof Error ? err.message : String(err) };
  } finally {
    compareLoading = false;
    render();
  }
}

async function runExport(format: "html" | "markdown") {
  if (!trajectory) return;
  statusBanner = { kind: "info", text: `Exporting ${format.toUpperCase()}...` };
  render();
  try {
    const res = await callServer("app_export_trajectory", {
      conversationId: trajectory.meta.conversationId,
      format,
    });
    const sc = res?.structuredContent as any;
    if (sc?.filePath) {
      statusBanner = {
        kind: "ok",
        text: `${t(lang, "exportSuccess")} ${sc.filePath} (${(sc.bytes / 1024).toFixed(1)} KiB)`,
      };
    }
  } catch (err) {
    statusBanner = { kind: "err", text: err instanceof Error ? err.message : String(err) };
  }
  render();
}

async function forkFromStep(stepIndex: number) {
  if (!trajectory) return;
  const caps = app.getHostCapabilities() as Record<string, unknown> | undefined;
  if (!caps?.message) return;

  forkStatusMsg = "Preparing handoff prompt...";
  render();
  try {
    const res = await callServer("app_build_fork_handoff", {
      conversationId: trajectory.meta.conversationId,
      upToStepIndex: stepIndex,
      mode: "balanced",
    });
    const prompt = (res?.structuredContent as any)?.prompt;
    if (!prompt) throw new Error("Failed to build handoff prompt");

    const msgRes = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: prompt }],
      _meta: {
        "com.google.antigravity/message": { target: "new" },
      },
    } as any);

    if (msgRes?.isError) {
      throw new Error("Host rejected handoff message");
    }
    const newId = (msgRes?._meta as any)?.["com.google.antigravity/message"]?.conversationId;
    forkStatusMsg = newId
      ? `${t(lang, "forkSuccess")}: ${newId}`
      : t(lang, "forkSuccess");
  } catch (err) {
    forkStatusMsg = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function openFileInSidePane(fileUri: string) {
  try {
    const result = await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri: fileUri },
      },
      ToggleAuxPaneResultSchema
    );
    if (result?.isError) {
      statusBanner = {
        kind: "info",
        text: `Unable to open file in side pane (${fileUri}). It may not be available in the current view.`,
      };
      render();
    }
  } catch (err: any) {
    statusBanner = {
      kind: "info",
      text: `Side-pane file open unsupported on this surface (${err?.message || fileUri}).`,
    };
    render();
  }
}

function renderSessionsTabHtml(): string {
  const q = sessionFilter.trim().toLowerCase();
  const filtered = sessions.filter((s) => {
    if (!q) return true;
    return `${s.title} ${s.conversationId} ${s.model || ""} ${s.surface}`.toLowerCase().includes(q);
  });

  return `
    <div class="tl-toolbar">
      <input id="tl-session-filter" class="tl-input" type="search" value="${esc(sessionFilter)}" placeholder="${esc(t(lang, "sessionFilterPlaceholder"))}" />
      <span class="tl-muted">${filtered.length} session(s)</span>
    </div>
    <div class="tl-card" style="padding:0;overflow-x:auto">
      <table class="tl-table">
        <thead>
          <tr><th>Title</th><th>Surface</th><th>Model</th><th>Steps</th><th>Errors</th><th>Updated</th><th></th></tr>
        </thead>
        <tbody>
          ${
            filtered.length === 0
              ? `<tr><td colspan="7" class="tl-muted">${esc(t(lang, "noSessions"))}</td></tr>`
              : filtered
                  .map(
                    (s) => `
                      <tr data-pick-session="${esc(s.conversationId)}" style="cursor:pointer;${s.conversationId === selectedConversationId ? "background:var(--tl-info-bg)" : ""}">
                        <td>
                          <strong>${esc(s.title)}</strong>
                          ${s.isActive ? `<span class="tl-pill ok">ACTIVE</span>` : ""}
                          ${s.hasSubagents ? `<span class="tl-pill info">subagents</span>` : ""}
                          ${s.hasHookTelemetry ? `<span class="tl-pill">hook</span>` : ""}
                          <div class="tl-muted tl-mono" style="font-size:10.5px">${esc(s.conversationId)}</div>
                        </td>
                        <td><span class="tl-pill">${esc(s.surface)}</span></td>
                        <td class="tl-mono">${esc(s.model || "—")}</td>
                        <td>${s.approxSteps}</td>
                        <td>${s.errorCount > 0 ? `<span class="tl-pill err">${s.errorCount}</span>` : "0"}</td>
                        <td class="tl-muted">${esc(fmtDateCompact(s.mtimeMs))}</td>
                        <td><button class="tl-btn" data-pick-session="${esc(s.conversationId)}">Open</button></td>
                      </tr>
                    `
                  )
                  .join("")
          }
        </tbody>
      </table>
    </div>
  `;
}

function render() {
  const root = document.getElementById("root");
  if (!root) return;

  const caps = app.getHostCapabilities() as Record<string, unknown> | undefined;
  const canMessageHost = Boolean(caps?.message);

  const sessionOptions = sessions
    .map(
      (s) =>
        `<option value="${esc(s.conversationId)}" ${s.conversationId === selectedConversationId ? "selected" : ""}>${s.isActive ? "● " : ""}${esc(s.title.slice(0, 42))} (${esc(s.conversationId.slice(0, 8))})</option>`
    )
    .join("");

  const tabs: Array<[TabId, string]> = [
    ["ledger", t(lang, "tabLedger")],
    ["graph", t(lang, "tabGraph")],
    ["subagents", t(lang, "tabSubagents")],
    ["analytics", t(lang, "tabAnalytics")],
    ["compare", t(lang, "tabCompare")],
    ["sessions", t(lang, "tabSessions")],
  ];

  const m = trajectory?.meta;
  const ts = trajectory?.tokenSummary;

  const kpiHtml = trajectory
    ? `
      <div class="tl-kpis">
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiTurns"))}</div><div class="tl-kpi-val">${m!.turnCount}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiSteps"))}</div><div class="tl-kpi-val">${m!.stepCount}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiInvocations"))}</div><div class="tl-kpi-val">${m!.invocationCount}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiTools"))}</div><div class="tl-kpi-val">${m!.toolCallCount}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiErrors"))}</div><div class="tl-kpi-val" style="color:${m!.errorCount > 0 ? "var(--tl-err)" : "inherit"}">${m!.errorCount}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiPeakCtx"))}</div><div class="tl-kpi-val">${fmtNum(ts!.peakContextTokens)}</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiCacheHit"))}</div><div class="tl-kpi-val">${(ts!.avgCacheHitRate * 100).toFixed(1)}%</div></div>
        <div class="tl-kpi"><div class="tl-kpi-label">${esc(t(lang, "kpiDuration"))}</div><div class="tl-kpi-val">${fmtMs(m!.durationMs)}</div></div>
      </div>
    `
    : "";

  let mainHtml = "";
  if (loading && !trajectory) {
    mainHtml = `<div class="tl-card"><div class="tl-muted">${esc(t(lang, "loading"))}</div></div>`;
  } else if (activeTab === "sessions") {
    mainHtml = renderSessionsTabHtml();
  } else if (activeTab === "compare") {
    mainHtml = renderCompareHtml(lang, sessions, compareLeftId, compareRightId, compareResult, compareLoading);
  } else if (!trajectory) {
    mainHtml = `<div class="tl-card"><div class="tl-muted">${esc(t(lang, "noSessions"))}</div></div>`;
  } else if (activeTab === "ledger") {
    mainHtml = renderLedgerHtml(trajectory, {
      lang,
      plainGuide,
      searchQuery: ledgerSearch,
      deepSearchResults,
      deepSearchLoading,
      filter: ledgerFilter,
      collapsedTurns,
      selectedStepIndex,
      replayActiveStepIndex,
      replayPlaying,
      replaySpeed,
      replayCursor,
      replayTotal: replayOrder.length,
    });
  } else if (activeTab === "graph") {
    mainHtml = renderGraphHtml(trajectory, {
      lang,
      orientation: graphOrientation,
      turnFilter: graphTurnFilter,
      categoryFilter: graphCategoryFilter,
      selectedStepIndex,
      zoom: graphZoom,
      panX: graphPanX,
      panY: graphPanY,
    });
  } else if (activeTab === "subagents") {
    mainHtml = renderSubagentsHtml(trajectory, lang, subagentStack);
  } else if (activeTab === "analytics") {
    mainHtml = renderAnalyticsHtml(trajectory, lang);
  }

  const showInspector = selectedStepIndex !== null || activeTab === "ledger" || activeTab === "graph";
  const inspectorHtml = showInspector
    ? `<aside class="tl-inspector ${selectedStepIndex === null ? "empty" : ""}">${renderInspectorHtml(
        lang,
        selectedStepIndex,
        stepDetail,
        stepDetailLoading,
        inspectorSubTab,
        canMessageHost,
        forkStatusMsg
      )}</aside>`
    : "";

  root.innerHTML = `
    <div class="tl-shell">
      <header class="tl-header">
        <div class="tl-header-top">
          <div class="tl-brand">
            <span class="tl-title">${esc(t(lang, "appTitle"))}</span>
            <select id="tl-session-select" class="tl-session-select" aria-label="Session picker">${sessionOptions}</select>
            <button class="tl-pill ${showScopeInfo ? "info" : "ok"}" data-toggle-scope="1" title="${esc(t(lang, "scopeNoticeTitle"))}">${esc(t(lang, "safeMode"))}</button>
            ${m ? `<span class="tl-pill ${m.hasHookTelemetry ? "ok" : ""}">${esc(m.hasHookTelemetry ? t(lang, "hookBadgeOn") : t(lang, "hookBadgeOff"))}</span>` : ""}
          </div>
          <div class="tl-actions">
            <button class="tl-btn ${liveFollow ? "active" : ""}" data-toggle-live="1">${esc(liveFollow ? t(lang, "liveOn") : t(lang, "liveOff"))}</button>
            <button class="tl-btn ${plainGuide ? "active" : ""}" data-toggle-plain="1">${esc(plainGuide ? t(lang, "plainOn") : t(lang, "plainOff"))}</button>
            <button class="tl-btn" data-toggle-lang="1">${lang === "zh" ? "EN" : "中文"}</button>
            <button class="tl-btn" data-export="html">${esc(t(lang, "exportHtml"))}</button>
            <button class="tl-btn" data-export="markdown">${esc(t(lang, "exportMd"))}</button>
            <button class="tl-btn" data-refresh="1">${esc(t(lang, "refresh"))}</button>
          </div>
        </div>
        <div class="tl-tabs">
          ${tabs
            .map(
              ([id, label]) =>
                `<button class="tl-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${esc(label)}</button>`
            )
            .join("")}
        </div>
      </header>
      ${kpiHtml}
      <div class="tl-workspace">
        <main class="tl-main">
          ${
            showScopeInfo
              ? `<div class="tl-banner info"><div class="tl-step-top"><strong>${esc(t(lang, "scopeNoticeTitle"))}</strong><button class="tl-btn" data-toggle-scope="1">✕</button></div><div style="margin-top:4px">${esc(t(lang, "scopeNoticeBody"))}</div></div>`
              : ""
          }
          ${
            statusBanner
              ? `<div class="tl-banner ${statusBanner.kind === "err" ? "warn" : statusBanner.kind === "ok" ? "ok" : "info"}"><div class="tl-step-top"><span>${esc(statusBanner.text)}</span><button class="tl-btn" data-dismiss-banner="1">✕</button></div></div>`
              : ""
          }
          ${mainHtml}
        </main>
        ${inspectorHtml}
      </div>
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  const sesSel = document.getElementById("tl-session-select") as HTMLSelectElement | null;
  sesSel?.addEventListener("change", () => {
    subagentStack.length = 0;
    stopReplayTimer();
    void loadTrajectory(sesSel.value);
  });

  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = normalizeTab(el.dataset.tab);
      if (activeTab === "compare" && !compareResult && sessions.length >= 2) {
        void runCompare();
      } else {
        render();
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-toggle-live]").forEach((el) =>
    el.addEventListener("click", () => {
      liveFollow = !liveFollow;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-toggle-plain]").forEach((el) =>
    el.addEventListener("click", () => {
      plainGuide = !plainGuide;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-toggle-lang]").forEach((el) =>
    el.addEventListener("click", () => {
      lang = lang === "zh" ? "en" : "zh";
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-toggle-scope]").forEach((el) =>
    el.addEventListener("click", () => {
      showScopeInfo = !showScopeInfo;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-dismiss-banner]").forEach((el) =>
    el.addEventListener("click", () => {
      statusBanner = null;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-refresh]").forEach((el) =>
    el.addEventListener("click", () => {
      void Promise.all([loadSessionsList(), loadTrajectory(selectedConversationId)]);
    })
  );

  document.querySelectorAll<HTMLElement>("[data-export]").forEach((el) =>
    el.addEventListener("click", () => {
      const fmt = el.dataset.export === "markdown" ? "markdown" : "html";
      void runExport(fmt);
    })
  );

  // Ledger search & filters
  const searchEl = document.getElementById("tl-ledger-search") as HTMLInputElement | null;
  searchEl?.addEventListener("input", () => {
    ledgerSearch = searchEl.value;
    render();
    const again = document.getElementById("tl-ledger-search") as HTMLInputElement | null;
    if (again) {
      again.focus();
      again.setSelectionRange(ledgerSearch.length, ledgerSearch.length);
    }
  });
  searchEl?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runDeepSearch();
    }
  });

  document.querySelectorAll<HTMLElement>("[data-deep-search]").forEach((el) =>
    el.addEventListener("click", () => void runDeepSearch())
  );

  document.querySelectorAll<HTMLElement>("[data-clear-deep-search]").forEach((el) =>
    el.addEventListener("click", () => {
      deepSearchResults = null;
      ledgerSearch = "";
      render();
    })
  );

  const sesFilterEl = document.getElementById("tl-session-filter") as HTMLInputElement | null;
  sesFilterEl?.addEventListener("input", () => {
    sessionFilter = sesFilterEl.value;
    render();
    const again = document.getElementById("tl-session-filter") as HTMLInputElement | null;
    if (again) {
      again.focus();
      again.setSelectionRange(sessionFilter.length, sessionFilter.length);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-filter]").forEach((el) =>
    el.addEventListener("click", () => {
      ledgerFilter = (el.dataset.filter as LedgerFilter) || "all";
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-toggle-turn]").forEach((el) =>
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.toggleTurn);
      if (collapsedTurns.has(idx)) collapsedTurns.delete(idx);
      else collapsedTurns.add(idx);
      render();
    })
  );

  // Replay controls
  document.querySelectorAll<HTMLElement>("[data-replay]").forEach((el) =>
    el.addEventListener("click", () => {
      const act = el.dataset.replay;
      if (act === "toggle") toggleReplay();
      else if (act === "prev") stepReplay(-1);
      else if (act === "next") stepReplay(1);
      else if (act === "reset") {
        stopReplayTimer();
        replayActiveStepIndex = null;
        replayCursor = 0;
        render();
      }
    })
  );

  const slider = document.getElementById("tl-replay-slider") as HTMLInputElement | null;
  slider?.addEventListener("input", () => {
    stopReplayTimer();
    replayCursor = Number(slider.value) || 0;
    replayActiveStepIndex = replayOrder[replayCursor] ?? null;
    render();
  });

  const speedSel = document.getElementById("tl-replay-speed") as HTMLSelectElement | null;
  speedSel?.addEventListener("change", () => {
    replaySpeed = Number(speedSel.value) || 1;
    if (replayPlaying) {
      stopReplayTimer();
      toggleReplay();
    }
  });

  // Step selection (Ledger, Analytics, Graph)
  document.querySelectorAll<HTMLElement>("[data-step]").forEach((el) => {
    if (el.classList.contains("tl-dag-node")) return; // handled with drag threshold below
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.step);
      if (Number.isFinite(idx)) void selectStep(idx);
    });
  });

  // Inspector controls
  document.querySelectorAll<HTMLElement>("[data-close-inspector]").forEach((el) =>
    el.addEventListener("click", () => {
      selectedStepIndex = null;
      stepDetail = null;
      forkStatusMsg = null;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-inspector-tab]").forEach((el) =>
    el.addEventListener("click", () => {
      inspectorSubTab = (el.dataset.inspectorTab as InspectorSubTab) || "overview";
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-load-more]").forEach((el) =>
    el.addEventListener("click", () => {
      const nextOffset = Number(el.dataset.loadMore) || 0;
      if (selectedStepIndex !== null) {
        void selectStep(selectedStepIndex, nextOffset, true);
      }
    })
  );

  document.querySelectorAll<HTMLElement>("[data-open-file]").forEach((el) =>
    el.addEventListener("click", () => {
      const uri = el.dataset.openFile;
      if (uri) void openFileInSidePane(uri);
    })
  );

  document.querySelectorAll<HTMLElement>("[data-fork-step]").forEach((el) =>
    el.addEventListener("click", () => {
      const sIdx = Number(el.dataset.forkStep);
      if (Number.isFinite(sIdx)) void forkFromStep(sIdx);
    })
  );

  document.querySelectorAll<HTMLElement>("[data-copy-step-json]").forEach((el) =>
    el.addEventListener("click", async () => {
      if (!stepDetail) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(stepDetail.rawStep, null, 2));
        el.textContent = t(lang, "copied");
      } catch {
        statusBanner = { kind: "info", text: "Clipboard unavailable in sandbox; switch to Raw JSON tab to copy manually." };
        render();
      }
    })
  );

  // Graph controls & pan/zoom
  const gTurn = document.getElementById("tl-graph-turn") as HTMLSelectElement | null;
  gTurn?.addEventListener("change", () => {
    graphTurnFilter = gTurn.value === "all" ? "all" : Number(gTurn.value);
    render();
  });

  const gCat = document.getElementById("tl-graph-cat") as HTMLSelectElement | null;
  gCat?.addEventListener("change", () => {
    graphCategoryFilter = gCat.value || "all";
    render();
  });

  document.querySelectorAll<HTMLElement>("[data-graph-orient]").forEach((el) =>
    el.addEventListener("click", () => {
      graphOrientation = el.dataset.graphOrient === "TB" ? "TB" : "LR";
      graphZoom = 1;
      graphPanX = 0;
      graphPanY = 0;
      render();
    })
  );

  document.querySelectorAll<HTMLElement>("[data-graph-zoom]").forEach((el) =>
    el.addEventListener("click", () => {
      const act = el.dataset.graphZoom;
      if (act === "in") graphZoom = Math.min(3, graphZoom * 1.25);
      else if (act === "out") graphZoom = Math.max(0.35, graphZoom / 1.25);
      else {
        graphZoom = 1;
        graphPanX = 0;
        graphPanY = 0;
      }
      render();
    })
  );

  const svgEl = document.getElementById("tl-graph-svg") as SVGSVGElement | null;
  const vpEl = document.getElementById("tl-graph-viewport") as SVGGElement | null;
  if (svgEl && vpEl) {
    svgEl.addEventListener("pointerdown", (ev) => {
      lastGraphDragMoved = 0;
      graphDragState = {
        vpEl,
        startX: ev.clientX,
        startY: ev.clientY,
        basePanX: graphPanX,
        basePanY: graphPanY,
        moved: 0,
      };
    });

    svgEl.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.12 : 0.89;
        graphZoom = Math.max(0.35, Math.min(3, graphZoom * factor));
        vpEl.setAttribute("transform", `translate(${graphPanX}, ${graphPanY}) scale(${graphZoom})`);
      },
      { passive: false }
    );

    svgEl.querySelectorAll<SVGGElement>(".tl-dag-node").forEach((nodeEl) => {
      nodeEl.addEventListener("click", () => {
        if (lastGraphDragMoved > 6) return;
        const idx = Number(nodeEl.dataset.step);
        if (Number.isFinite(idx)) void selectStep(idx);
      });
    });
  }

  // Subagents drill-down
  document.querySelectorAll<HTMLElement>("[data-drill-subagent]").forEach((el) =>
    el.addEventListener("click", () => {
      const childId = el.dataset.drillSubagent;
      if (childId && trajectory) {
        subagentStack.push({
          conversationId: trajectory.meta.conversationId,
          title: trajectory.meta.title,
        });
        void loadTrajectory(childId);
      }
    })
  );

  document.querySelectorAll<HTMLElement>("[data-subagent-back]").forEach((el) =>
    el.addEventListener("click", () => {
      const prev = subagentStack.pop();
      if (prev) void loadTrajectory(prev.conversationId);
    })
  );

  // Compare
  const cmpL = document.getElementById("tl-cmp-left") as HTMLSelectElement | null;
  cmpL?.addEventListener("change", () => {
    compareLeftId = cmpL.value;
  });
  const cmpR = document.getElementById("tl-cmp-right") as HTMLSelectElement | null;
  cmpR?.addEventListener("change", () => {
    compareRightId = cmpR.value;
  });
  document.querySelectorAll<HTMLElement>("[data-run-compare]").forEach((el) =>
    el.addEventListener("click", () => void runCompare())
  );

  // Sessions picker rows
  document.querySelectorAll<HTMLElement>("[data-pick-session]").forEach((el) =>
    el.addEventListener("click", () => {
      const cid = el.dataset.pickSession;
      if (cid) {
        activeTab = "ledger";
        subagentStack.length = 0;
        void loadTrajectory(cid);
      }
    })
  );
}

// Register handlers BEFORE connect() per MCP Apps contract
app.ontoolinput = () => {
  loading = true;
  render();
};

app.ontoolresult = (result: any) => {
  loading = false;
  const sc = result?.structuredContent as any;
  if (sc && typeof sc === "object") {
    if (sc.initialTab) activeTab = normalizeTab(sc.initialTab);
    if (typeof sc.plainGuide === "boolean") plainGuide = sc.plainGuide;
    if (sc.activeConversationId) activeConversationId = sc.activeConversationId;
    if (Array.isArray(sc.sessions)) {
      sessions = sc.sessions;
      if (!compareLeftId && sessions.length >= 1) compareLeftId = sessions[0].conversationId;
      if (!compareRightId && sessions.length >= 2) compareRightId = sessions[1].conversationId;
    }
    if (sc.trajectory) {
      trajectory = sc.trajectory as TrajectoryData;
      selectedConversationId = trajectory.meta.conversationId;
      rebuildReplayOrder();
    } else if (sc.loadError) {
      statusBanner = { kind: "err", text: String(sc.loadError) };
    }
  }
  render();
};

app.ontoolcancelled = () => {
  loading = false;
  render();
};

app.onhostcontextchanged = (ctx: any) => {
  applyHostCtx(ctx);
  render();
};

render();

app
  .connect()
  .then(() => {
    applyHostCtx(app.getHostContext());
    if (!trajectory) {
      void Promise.all([loadSessionsList(), loadTrajectory(null)]);
    } else {
      render();
    }

    const pollTick = async () => {
      if (!liveFollow || document.hidden || loading) return;
      const tag = document.activeElement?.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
      try {
        const res = await callServer("app_poll_revision", {
          ...(selectedConversationId ? { conversationId: selectedConversationId } : {}),
        });
        const sc = res?.structuredContent as any;
        if (!sc) return;
        if (sc.activeConversationId) activeConversationId = sc.activeConversationId;
        if (
          trajectory &&
          sc.conversationId === trajectory.meta.conversationId &&
          sc.revision &&
          sc.revision !== trajectory.meta.revision
        ) {
          await loadTrajectory(trajectory.meta.conversationId, true);
        } else if (!trajectory && sc.conversationId) {
          await loadTrajectory(sc.conversationId, false);
        }
      } catch {
        // silent poll failure
      }
    };

    window.setInterval(() => void pollTick(), 3500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void pollTick();
    });
  })
  .catch((err) => {
    loading = false;
    statusBanner = {
      kind: "err",
      text: `MCP App connect error: ${err instanceof Error ? err.message : String(err)}`,
    };
    render();
  });
