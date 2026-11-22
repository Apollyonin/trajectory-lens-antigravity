import { GLOSSARY_EN, GLOSSARY_ZH, t } from "./i18n.ts";
import type {
  InspectorSubTab,
  Lang,
  LedgerFilter,
  StepDetailData,
  TrajectoryData,
} from "./types.ts";
import { esc, fmtMs, fmtNum, fmtTimeShort } from "./utils.ts";

export interface LedgerRenderState {
  lang: Lang;
  plainGuide: boolean;
  searchQuery: string;
  deepSearchResults: { query: string; totalMatches: number; matches: any[] } | null;
  deepSearchLoading: boolean;
  filter: LedgerFilter;
  collapsedTurns: Set<number>;
  selectedStepIndex: number | null;
  replayActiveStepIndex: number | null;
  replayPlaying: boolean;
  replaySpeed: number;
  replayCursor: number;
  replayTotal: number;
}

function stepMatchesSearch(text: string, q: string): boolean {
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

export function renderLedgerHtml(traj: TrajectoryData, state: LedgerRenderState): string {
  const { lang, plainGuide } = state;
  const q = state.searchQuery.trim().toLowerCase();
  const f = state.filter;

  const parts: string[] = [];

  if (plainGuide) {
    const gloss = lang === "zh" ? GLOSSARY_ZH : GLOSSARY_EN;
    parts.push(`
      <div class="tl-banner info">
        <div><strong>${esc(t(lang, "plainGuideBanner"))}</strong></div>
        <div class="tl-glossary-grid">
          ${gloss
            .map(
              (g) =>
                `<div class="tl-glossary-item"><strong>${esc(g.term)}</strong><div class="tl-muted">${esc(g.plain)}</div></div>`
            )
            .join("")}
        </div>
      </div>
    `);
  }

  // Search + Filter Chips
  const filters: Array<[LedgerFilter, string]> = [
    ["all", t(lang, "filterAll")],
    ["planner", t(lang, "filterPlanner")],
    ["tools", t(lang, "filterTools")],
    ["errors", t(lang, "filterErrors")],
    ["checkpoints", t(lang, "filterCheckpoints")],
    ["subagents", t(lang, "filterSubagents")],
    ["system", t(lang, "filterSystem")],
  ];

  parts.push(`
    <div class="tl-toolbar">
      <input id="tl-ledger-search" class="tl-input" type="search" value="${esc(state.searchQuery)}" placeholder="${esc(t(lang, "searchPlaceholder"))}" />
      <button class="tl-btn" data-deep-search="1" ${state.deepSearchLoading ? "disabled" : ""}>${esc(t(lang, "deepSearch"))}</button>
      ${state.deepSearchResults ? `<button class="tl-btn" data-clear-deep-search="1">${esc(t(lang, "clearSearch"))}</button>` : ""}
    </div>
    ${
      state.deepSearchLoading
        ? `<div class="tl-card"><div class="tl-muted">${esc(t(lang, "loading"))}</div></div>`
        : state.deepSearchResults
        ? `<div class="tl-card">
             <div class="tl-card-hd">
               <span>${esc(t(lang, "deepSearchMatches"))}: ${state.deepSearchResults.totalMatches}${state.deepSearchResults.query ? ` ("${esc(state.deepSearchResults.query)}")` : ""}</span>
               <button class="tl-btn" data-clear-deep-search="1">✕</button>
             </div>
             ${
               state.deepSearchResults.matches.length === 0
                 ? `<div class="tl-muted">0 matches.</div>`
                 : state.deepSearchResults.matches
                     .slice(0, 30)
                     .map(
                       (m) => `
                         <div class="tl-step-row" data-step="${m.stepIndex}">
                           <div class="tl-step-top">
                             <div class="tl-step-left">
                               <span class="tl-step-idx">#${m.stepIndex}</span>
                               <span class="tl-pill">T${m.turnIndex}</span>
                               <span class="tl-pill info">${esc(m.type)} · ${esc(m.field)}</span>
                             </div>
                           </div>
                           <div class="tl-step-preview tl-mono">${esc(m.snippet)}</div>
                         </div>
                       `
                     )
                     .join("")
             }
           </div>`
        : ""
    }
    <div class="tl-chip-row">
      ${filters
        .map(
          ([key, label]) =>
            `<button class="tl-chip ${f === key ? "active" : ""}" data-filter="${key}">${esc(label)}</button>`
        )
        .join("")}
    </div>
  `);

  // Replay scrubber
  parts.push(`
    <div class="tl-replay-bar">
      <button class="tl-btn" data-replay="toggle">${state.replayPlaying ? esc(t(lang, "replayPause")) : esc(t(lang, "replayPlay"))}</button>
      <button class="tl-btn" data-replay="prev">${esc(t(lang, "replayPrev"))}</button>
      <button class="tl-btn" data-replay="next">${esc(t(lang, "replayNext"))}</button>
      <input id="tl-replay-slider" type="range" min="0" max="${Math.max(0, state.replayTotal - 1)}" value="${Math.max(0, state.replayCursor)}" />
      <select id="tl-replay-speed" class="tl-btn" aria-label="Replay speed">
        ${[1, 5, 20]
          .map(
            (sp) =>
              `<option value="${sp}" ${state.replaySpeed === sp ? "selected" : ""}>${sp}x</option>`
          )
          .join("")}
      </select>
      <span class="tl-muted tl-mono">${
        state.replayActiveStepIndex !== null
          ? `#${state.replayActiveStepIndex} (${state.replayCursor + 1}/${state.replayTotal})`
          : `0/${state.replayTotal}`
      }</span>
      ${state.replayActiveStepIndex !== null ? `<button class="tl-btn" data-replay="reset">${esc(t(lang, "replayReset"))}</button>` : ""}
    </div>
  `);

  // Turns
  for (const turn of traj.turns) {
    const isCollapsed = state.collapsedTurns.has(turn.turnIndex);
    const turnBody: string[] = [];

    if (plainGuide && turn.plainSummary) {
      turnBody.push(
        `<div class="tl-turn-plain">${esc(lang === "zh" ? turn.plainSummary.zh : turn.plainSummary.en)}</div>`
      );
    }

    if (turn.userStepIndex !== null && (f === "all")) {
      const userText = turn.userGoal || "";
      if (stepMatchesSearch(userText, q)) {
        const selected = state.selectedStepIndex === turn.userStepIndex;
        const rActive = state.replayActiveStepIndex === turn.userStepIndex;
        turnBody.push(`
          <div class="tl-step-row ${selected ? "selected" : ""} ${rActive ? "replay-active" : ""}" data-step="${turn.userStepIndex}">
            <div class="tl-step-top">
              <div class="tl-step-left">
                <span class="tl-step-idx">#${turn.userStepIndex}</span>
                <span class="tl-pill info">USER_INPUT</span>
                <span>${esc(userText.slice(0, 90))}</span>
              </div>
              <span class="tl-muted">${esc(fmtTimeShort(turn.startedAt))}</span>
            </div>
          </div>
        `);
      }
    }

    for (const inv of turn.invocations) {
      const showPlanner =
        f === "all" ||
        f === "planner" ||
        (f === "errors" && inv.status === "ERROR");

      const invSearchText = `${inv.model || ""} ${inv.thinkingPreview} ${inv.replyPreview} ${inv.toolCalls.map((tc) => `${tc.name} ${tc.argsSummary} ${tc.error || ""}`).join(" ")}`;

      if (showPlanner && stepMatchesSearch(invSearchText, q)) {
        const selected = state.selectedStepIndex === inv.stepIndex;
        const rActive = state.replayActiveStepIndex === inv.stepIndex;
        turnBody.push(`
          <div class="tl-step-row ${selected ? "selected" : ""} ${rActive ? "replay-active" : ""}" data-step="${inv.stepIndex}">
            <div class="tl-step-top">
              <div class="tl-step-left">
                <span class="tl-step-idx">#${inv.stepIndex}</span>
                <span class="tl-pill">PLANNER</span>
                <span class="tl-mono">${esc(inv.model || "-")}</span>
                ${inv.thinkingLength > 0 ? `<span class="tl-pill info">Thought ${fmtNum(inv.thinkingLength)}c</span>` : ""}
                ${inv.toolCalls.length > 0 ? `<span class="tl-pill">${inv.toolCalls.length} tools</span>` : ""}
              </div>
              <div class="tl-turn-meta">
                <span>ctx ${fmtNum(inv.contextTokens)}</span>
                <span>cache ${(inv.cacheHitRate * 100).toFixed(0)}%</span>
                <span>${fmtMs(inv.durationMs)}</span>
              </div>
            </div>
            ${inv.replyPreview ? `<div class="tl-step-preview">${esc(inv.replyPreview)}</div>` : inv.thinkingPreview ? `<div class="tl-step-preview">${esc(inv.thinkingPreview)}</div>` : ""}
          </div>
        `);
      }

      for (const tc of inv.toolCalls) {
        const tcStep = tc.stepIndex ?? inv.stepIndex;
        const isSub = Boolean(tc.subagentSpawn?.childConversationId);
        const showTool =
          f === "all" ||
          f === "tools" ||
          (f === "errors" && Boolean(tc.error)) ||
          (f === "subagents" && isSub);
        const tcHay = `${tc.name} ${tc.category} ${tc.argsSummary} ${tc.error || ""} ${tc.outputPreview} ${tc.fileRefs.join(" ")}`;
        if (!showTool || !stepMatchesSearch(tcHay, q)) continue;

        const selected = state.selectedStepIndex === tcStep;
        const rActive = state.replayActiveStepIndex === tcStep;
        const catCls = tc.error ? "tl-cat-err" : `tl-cat-${tc.category}`;
        turnBody.push(`
          <div class="tl-step-row tl-tool-indent ${catCls} ${selected ? "selected" : ""} ${rActive ? "replay-active" : ""}" data-step="${tcStep}">
            <div class="tl-step-top">
              <div class="tl-step-left">
                <span class="tl-step-idx">#${tcStep}</span>
                <strong>${esc(tc.name)}</strong>
                <span class="tl-pill">${esc(tc.category)}</span>
                ${tc.error ? `<span class="tl-pill err">${esc(tc.error.slice(0, 48))}</span>` : `<span class="tl-pill ok">DONE</span>`}
                ${isSub ? `<span class="tl-pill info">subagent:${esc(tc.subagentSpawn!.childConversationId!.slice(0, 8))}</span>` : ""}
              </div>
              <div class="tl-turn-meta">
                <span>${fmtMs(tc.durationMs)}</span>
              </div>
            </div>
            <div class="tl-step-preview tl-mono">${esc(tc.argsSummary || tc.outputPreview)}</div>
          </div>
        `);
      }
    }

    for (const ev of turn.events) {
      const isCp = ev.type === "CHECKPOINT" || ev.type === "COMPACTION";
      const isErr = ev.type === "ERROR_MESSAGE" || ev.status === "ERROR" || Boolean(ev.error);
      const isSubCb = Boolean(ev.subagentCallbackId);
      const showEv =
        f === "all" ||
        (f === "checkpoints" && isCp) ||
        (f === "errors" && isErr) ||
        (f === "subagents" && isSubCb) ||
        (f === "system" && (ev.type === "SYSTEM_MESSAGE" || isCp));
      const evHay = `${ev.type} ${ev.contentPreview || ""} ${ev.error || ""}`;
      if (!showEv || !stepMatchesSearch(evHay, q)) continue;

      const selected = state.selectedStepIndex === ev.stepIndex;
      const rActive = state.replayActiveStepIndex === ev.stepIndex;
      turnBody.push(`
        <div class="tl-step-row ${selected ? "selected" : ""} ${rActive ? "replay-active" : ""}" data-step="${ev.stepIndex}">
          <div class="tl-step-top">
            <div class="tl-step-left">
              <span class="tl-step-idx">#${ev.stepIndex}</span>
              <span class="tl-pill ${isErr ? "err" : isCp ? "warn" : ""}">${esc(ev.type)}</span>
              ${ev.subagentCallbackId ? `<span class="tl-pill info">callback:${esc(ev.subagentCallbackId.slice(0, 8))}</span>` : ""}
            </div>
            <span class="tl-muted">${esc(fmtTimeShort(ev.createdAt))}</span>
          </div>
          <div class="tl-step-preview">${esc(ev.contentPreview || ev.error || "")}</div>
        </div>
      `);
    }

    if (turnBody.length === 0 && (q || f !== "all")) continue;

    parts.push(`
      <div class="tl-turn">
        <div class="tl-turn-hd" data-toggle-turn="${turn.turnIndex}">
          <div class="tl-turn-title">${isCollapsed ? "▸" : "▾"} Turn ${turn.turnIndex}: ${esc(turn.userGoal ? turn.userGoal.slice(0, 85) : "Bootstrap / System")}</div>
          <div class="tl-turn-meta">
            <span>${turn.invocations.length} inv</span>
            <span>${fmtMs(turn.durationMs)}</span>
          </div>
        </div>
        ${isCollapsed ? "" : turnBody.join("")}
      </div>
    `);
  }

  return parts.join("");
}

export function renderInspectorHtml(
  lang: Lang,
  selectedStepIndex: number | null,
  detail: StepDetailData | null,
  loading: boolean,
  subTab: InspectorSubTab,
  canMessageHost: boolean,
  forkStatusMsg: string | null
): string {
  if (selectedStepIndex === null) {
    return `
      <div class="tl-inspector-hd">
        <strong>Step Inspector</strong>
      </div>
      <div class="tl-inspector-body">
        <div class="tl-muted">${esc(t(lang, "inspectHint"))}</div>
      </div>
    `;
  }

  if (loading && !detail) {
    return `
      <div class="tl-inspector-hd">
        <strong>Step #${selectedStepIndex}</strong>
        <button class="tl-btn" data-close-inspector="1">✕</button>
      </div>
      <div class="tl-inspector-body"><div class="tl-muted">${esc(t(lang, "loading"))}</div></div>
    `;
  }

  if (!detail) {
    return `
      <div class="tl-inspector-hd">
        <strong>Step #${selectedStepIndex}</strong>
        <button class="tl-btn" data-close-inspector="1">✕</button>
      </div>
      <div class="tl-inspector-body"><div class="tl-muted">No step details available.</div></div>
    `;
  }

  const tabs: Array<[InspectorSubTab, string]> = [
    ["overview", t(lang, "subOverview")],
    ["thinking", t(lang, "subThinking")],
    ["toolio", t(lang, "subToolIo")],
    ["raw", t(lang, "subRaw")],
  ];

  let bodyHtml = "";
  if (subTab === "overview") {
    bodyHtml = `
      <div class="tl-card">
        <div class="tl-turn-meta" style="flex-wrap:wrap;gap:6px">
          <span class="tl-pill">${esc(detail.type)}</span>
          <span class="tl-pill ${detail.error ? "err" : "ok"}">${esc(detail.status || "DONE")}</span>
          ${detail.model ? `<span class="tl-pill info">${esc(detail.model)}</span>` : ""}
          ${detail.durationMs !== null ? `<span class="tl-pill">${fmtMs(detail.durationMs)}</span>` : ""}
          ${detail.hookEvent?.toolCallId ? `<span class="tl-pill">hook:${esc(detail.hookEvent.toolCallId)}</span>` : ""}
        </div>
        ${detail.error ? `<div style="margin-top:8px;color:var(--tl-err);font-weight:600">Error: ${esc(detail.error)}</div>` : ""}
        ${
          detail.inputTokens !== null || detail.outputTokens !== null
            ? `<div class="tl-muted" style="margin-top:6px">input=${fmtNum(detail.inputTokens)} · cache_read=${fmtNum(detail.cacheReadTokens)} · output=${fmtNum(detail.outputTokens)}</div>`
            : ""
        }
      </div>
      ${
        detail.pairedToolCall
          ? `<div class="tl-card"><div class="tl-card-hd"><span>Tool Input: ${esc(detail.pairedToolCall.name)}</span><span class="tl-muted tl-mono">from #${detail.pairedToolCall.plannerStepIndex}</span></div><pre class="tl-pre">${esc(JSON.stringify(detail.pairedToolCall.args ?? {}, null, 2))}</pre></div>`
          : ""
      }
      ${
        detail.toolCalls.length > 0
          ? `<div class="tl-card"><div class="tl-card-hd">Tool Calls (${detail.toolCalls.length})</div><pre class="tl-pre">${esc(JSON.stringify(detail.toolCalls, null, 2))}</pre></div>`
          : ""
      }
      ${
        detail.content
          ? `<div class="tl-card"><div class="tl-card-hd">Content</div><pre class="tl-pre">${esc(detail.content)}</pre></div>`
          : ""
      }
    `;
  } else if (subTab === "thinking") {
    bodyHtml = detail.thinking
      ? `<div class="tl-banner info">Antigravity Thought Summary (${detail.thinking.length} chars)</div><pre class="tl-pre">${esc(detail.thinking)}</pre>`
      : `<div class="tl-muted">No thinking summary recorded on this step.</div>`;
  } else if (subTab === "toolio") {
    const ext = detail.externalOutput;
    bodyHtml = `
      ${
        detail.pairedToolCall
          ? `<div class="tl-card"><div class="tl-card-hd"><span>Tool Input: ${esc(detail.pairedToolCall.name)}</span><span class="tl-muted tl-mono">from #${detail.pairedToolCall.plannerStepIndex}</span></div><pre class="tl-pre">${esc(JSON.stringify(detail.pairedToolCall.args ?? {}, null, 2))}</pre></div>`
          : ""
      }
      ${
        detail.toolCalls.length > 0
          ? `<div class="tl-card"><div class="tl-card-hd">Tool Arguments</div><pre class="tl-pre">${esc(JSON.stringify(detail.toolCalls, null, 2))}</pre></div>`
          : ""
      }
      ${
        detail.hookEvent
          ? `<div class="tl-card"><div class="tl-card-hd">Hook Telemetry</div><pre class="tl-pre">${esc(JSON.stringify(detail.hookEvent, null, 2))}</pre></div>`
          : ""
      }
      <div class="tl-card">
        <div class="tl-card-hd">Step Content / Output</div>
        <pre class="tl-pre">${esc(detail.content || "(empty)")}</pre>
      </div>
      ${
        ext
          ? `<div class="tl-card">
              <div class="tl-card-hd">
                <span>External Artifact (${(ext.totalBytes / 1024).toFixed(1)} KiB)</span>
                ${ext.hasMore ? `<button class="tl-btn" data-load-more="${ext.offset + ext.limit}">${esc(t(lang, "loadMore"))}</button>` : ""}
              </div>
              <div class="tl-muted tl-mono" style="font-size:10.5px;margin-bottom:6px">${esc(ext.filePath)}</div>
              <pre class="tl-pre">${esc(ext.text)}</pre>
            </div>`
          : ""
      }
    `;
  } else {
    bodyHtml = `<pre class="tl-pre">${esc(JSON.stringify(detail.rawStep, null, 2))}</pre>`;
  }

  const fileBtns = (detail.fileUris || [])
    .filter((f) => Boolean(f.uri))
    .slice(0, 3)
    .map(
      (f) =>
        `<button class="tl-btn" data-open-file="${esc(f.uri!)}" title="${esc(f.path)}">${esc(t(lang, "openFile"))}: ${esc(f.path.split(/[\\/]/).pop() || f.path)}</button>`
    )
    .join("");

  return `
    <div class="tl-inspector-hd">
      <strong>Step #${detail.stepIndex} · ${esc(detail.type)}</strong>
      <button class="tl-btn" data-close-inspector="1">✕</button>
    </div>
    <div class="tl-inspector-tabs">
      ${tabs
        .map(
          ([k, lbl]) =>
            `<button class="tl-chip ${subTab === k ? "active" : ""}" data-inspector-tab="${k}">${esc(lbl)}</button>`
        )
        .join("")}
    </div>
    <div class="tl-inspector-body">
      ${forkStatusMsg ? `<div class="tl-banner ok">${esc(forkStatusMsg)}</div>` : ""}
      ${bodyHtml}
    </div>
    <div class="tl-inspector-actions">
      ${fileBtns}
      ${canMessageHost ? `<button class="tl-btn primary" data-fork-step="${detail.stepIndex}">${esc(t(lang, "forkHere"))}</button>` : ""}
      <button class="tl-btn" data-copy-step-json="1">${esc(t(lang, "copyJson"))}</button>
    </div>
  `;
}
