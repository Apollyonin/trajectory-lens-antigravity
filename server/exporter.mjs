import fs from "node:fs";
import path from "node:path";
import { getPluginDataDir, resolveSessionPaths, toFileUri } from "./paths.mjs";
import { parseJsonlDeduplicated, parseTrajectory } from "./parser.mjs";

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(1);
  return `${mins}m ${secs}s`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeInlineJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function resolveExportDir(traj, outputDir, pluginDataDir) {
  if (outputDir && typeof outputDir === "string" && outputDir.trim()) {
    return path.resolve(outputDir.trim());
  }
  const ws = traj.meta.workspacePaths?.[0];
  if (ws && fs.existsSync(ws)) {
    return path.join(ws, "trajectory-exports");
  }
  return path.join(pluginDataDir || getPluginDataDir(), "exports");
}

export function exportMarkdownReport(traj) {
  const lines = [];
  const m = traj.meta;
  const ts = traj.tokenSummary;

  lines.push(`# Trajectory Lens Audit Report — ${m.title}`);
  lines.push("");
  lines.push(`- **Conversation ID**: \`${m.conversationId}\``);
  lines.push(`- **Surface**: \`${m.surface}\``);
  lines.push(`- **Primary Model**: \`${m.model || "unknown"}\``);
  lines.push(`- **Started / Ended**: ${m.startedAt || "-"} → ${m.endedAt || "-"}`);
  lines.push(`- **Duration**: ${formatDuration(m.durationMs)}`);
  lines.push(`- **Mode**: Official Safe Mode (local \`transcript.jsonl\` + \`hooks.json\` telemetry)`);
  lines.push("");

  lines.push("## Summary KPIs");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| :--- | :--- |");
  lines.push(`| Turns | ${m.turnCount} |`);
  lines.push(`| Steps | ${m.stepCount} |`);
  lines.push(`| Model Invocations | ${m.invocationCount} |`);
  lines.push(`| Tool Calls | ${m.toolCallCount} |`);
  lines.push(`| Errors | ${m.errorCount} |`);
  lines.push(`| Compaction Checkpoints | ${m.compactionCount} |`);
  lines.push(`| Subagents Spawned | ${m.subagentCount} |`);
  lines.push(`| Peak Context Tokens | ${ts.peakContextTokens.toLocaleString()} |`);
  lines.push(`| Avg Prompt Cache Hit Rate | ${(ts.avgCacheHitRate * 100).toFixed(1)}% |`);
  lines.push(`| Total Output Tokens | ${ts.totalOutputTokens.toLocaleString()} |`);
  lines.push("");

  if (traj.analytics.insights.length > 0) {
    lines.push("## Automated Pattern Insights");
    lines.push("");
    for (const ins of traj.analytics.insights) {
      lines.push(`- **[${ins.severity.toUpperCase()}] ${ins.titleZh}** (${ins.titleEn}): ${ins.detailZh}`);
    }
    lines.push("");
  }

  lines.push("## Turn-by-Turn Ledger");
  lines.push("");
  for (const t of traj.turns) {
    lines.push(`### Turn ${t.turnIndex}${t.userGoal ? `: ${t.userGoal.slice(0, 120)}` : ""}`);
    lines.push("");
    lines.push(`> ${t.plainSummary?.zh || ""}`);
    lines.push("");
    lines.push(
      `- Duration: ${formatDuration(t.durationMs)} | Input: ${t.totalInputTokens.toLocaleString()} | Cache Read: ${t.totalCacheReadTokens.toLocaleString()} | Output: ${t.totalOutputTokens.toLocaleString()}`
    );
    lines.push("");
    for (const inv of t.invocations) {
      lines.push(
        `- **Step #${inv.stepIndex} PLANNER** (\`${inv.model || "-"}\`, ctx=${inv.contextTokens.toLocaleString()}, out=${inv.outputTokens.toLocaleString()}, cache=${(inv.cacheHitRate * 100).toFixed(1)}%, ${formatDuration(inv.durationMs)})`
      );
      if (inv.thinkingPreview) {
        lines.push(`  - *Thought summary*: ${inv.thinkingPreview.replace(/\r?\n/g, " ")}`);
      }
      for (const tc of inv.toolCalls) {
        lines.push(
          `  - Tool \`#${tc.stepIndex ?? "?"}\` **${tc.name}** [${tc.category}] (${formatDuration(tc.durationMs)}) — \`${tc.argsSummary.replace(/`/g, "'")}\`${tc.error ? ` ❌ **${tc.error}**` : ""}`
        );
      }
      if (inv.replyPreview) {
        lines.push(`  - *Assistant reply*: ${inv.replyPreview.replace(/\r?\n/g, " ")}`);
      }
    }
    for (const ev of t.events) {
      lines.push(
        `- **Step #${ev.stepIndex} ${ev.type}** (${ev.status}): ${(ev.contentPreview || ev.error || "").replace(/\r?\n/g, " ")}`
      );
    }
    lines.push("");
  }

  if (traj.subagentTree && traj.subagentTree.children?.length > 0) {
    lines.push("## Subagent Tree");
    lines.push("");
    const walk = (node, depth = 0) => {
      const indent = "  ".repeat(depth);
      lines.push(
        `${indent}- **${node.role}** (\`${node.typeName}\`, \`${node.conversationId}\`) — model: \`${node.model || "-"}\`, steps: ${node.stepCount}, tools: ${node.toolCallCount}, duration: ${formatDuration(node.durationMs)}`
      );
      for (const ch of node.children || []) walk(ch, depth + 1);
    };
    walk(traj.subagentTree);
    lines.push("");
  }

  return lines.join("\n");
}

export function exportStandaloneHtmlReport(traj, fullStepsMap = new Map()) {
  const payload = {
    meta: traj.meta,
    tokenSummary: traj.tokenSummary,
    turns: traj.turns,
    analytics: traj.analytics,
    subagentTree: traj.subagentTree,
    fullSteps: Object.fromEntries(fullStepsMap.entries()),
  };

  const title = escapeHtml(traj.meta.title);
  const jsonText = safeInlineJson(payload);

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trajectory Lens Export — ${title}</title>
  <style>
    :root { --bg:#0d1117; --bg2:#161b22; --bg3:#21262d; --fg:#e6edf3; --fg2:#8b949e; --border:#30363d; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --err:#f85149; --purple:#bc8cff; }
    [data-theme="light"] { --bg:#f6f8fa; --bg2:#ffffff; --bg3:#eaeef2; --fg:#1f2328; --fg2:#656d76; --border:#d0d7de; --accent:#0969da; --ok:#1a7f37; --warn:#9a6700; --err:#cf222e; --purple:#8250df; }
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    header{position:sticky;top:0;z-index:10;background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
    .brand{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
    .badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--bg3);color:var(--fg2);border:1px solid var(--border)}
    .controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    input,button{background:var(--bg3);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px}
    button{cursor:pointer} button:hover{border-color:var(--accent)}
    main{max-width:1280px;margin:0 auto;padding:16px 20px 60px;display:grid;gap:16px}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
    .kpi{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
    .kpi .k{font-size:11px;color:var(--fg2)} .kpi .v{font-size:18px;font-weight:700;margin-top:2px}
    .card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px}
    .turn{border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden}
    .turn-hd{padding:10px 14px;background:var(--bg3);display:flex;justify-content:space-between;gap:12px;cursor:pointer;font-weight:600}
    .turn-sub{padding:8px 14px;font-size:12px;color:var(--fg2);border-bottom:1px solid var(--border)}
    .inv{padding:10px 14px;border-bottom:1px solid var(--border)}
    .inv:last-child{border-bottom:none}
    .tool{margin:6px 0 0 14px;padding:8px 10px;border-left:3px solid var(--accent);background:var(--bg3);border-radius:0 6px 6px 0}
    .tool.err{border-left-color:var(--err)}
    pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:11.5px;max-height:360px;overflow:auto}
    .muted{color:var(--fg2)} .row{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}
  </style>
</head>
<body>
  <header>
    <div class="brand">Trajectory Lens Offline Replay <span class="badge">Official Safe Mode</span></div>
    <div class="controls">
      <input id="q" type="search" placeholder="Search tools, prompts, errors..." />
      <button id="playBtn">Play Replay</button>
      <span id="playPos" class="muted"></span>
      <button id="themeBtn">Theme</button>
    </div>
  </header>
  <main id="app"></main>
  <script>
    const DATA = ${jsonText};
    let query = "";
    let playIdx = -1;
    let timer = null;
    const allSteps = [];
    for (const t of DATA.turns) {
      for (const inv of t.invocations) {
        allSteps.push(inv.stepIndex);
        for (const tc of inv.toolCalls) if (tc.stepIndex != null) allSteps.push(tc.stepIndex);
      }
      for (const ev of t.events) allSteps.push(ev.stepIndex);
    }
    const fmtMs = (ms) => ms == null ? "-" : ms < 1000 ? ms + "ms" : (ms/1000).toFixed(2) + "s";
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    function render() {
      const root = document.getElementById("app");
      const m = DATA.meta, ts = DATA.tokenSummary;
      const q = query.trim().toLowerCase();
      let html = '<div class="card"><div class="row"><div><strong>' + esc(m.title) + '</strong><div class="muted">' + esc(m.conversationId) + ' · ' + esc(m.model || "-") + ' · ' + esc(m.startedAt || "") + '</div></div><div class="badge">Duration ' + fmtMs(m.durationMs) + '</div></div></div>';
      html += '<div class="kpis">' +
        [['Turns', m.turnCount], ['Steps', m.stepCount], ['Invocations', m.invocationCount], ['Tools', m.toolCallCount], ['Errors', m.errorCount], ['Peak Context', ts.peakContextTokens.toLocaleString()], ['Cache Hit', (ts.avgCacheHitRate*100).toFixed(1)+'%'], ['Output Tok', ts.totalOutputTokens.toLocaleString()]]
        .map(([k,v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('') + '</div>';
      for (const t of DATA.turns) {
        const tJson = JSON.stringify(t).toLowerCase();
        if (q && !tJson.includes(q)) continue;
        html += '<div class="turn"><div class="turn-hd"><span>Turn ' + t.turnIndex + ': ' + esc((t.userGoal || "Bootstrap").slice(0,100)) + '</span><span class="muted">' + fmtMs(t.durationMs) + '</span></div>';
        if (t.plainSummary) html += '<div class="turn-sub">' + esc(t.plainSummary.zh) + '</div>';
        for (const inv of t.invocations) {
          const active = playIdx >= 0 && allSteps[playIdx] === inv.stepIndex;
          html += '<div class="inv" style="' + (active ? 'outline:2px solid var(--accent)' : '') + '">';
          html += '<div class="row"><strong>Step #' + inv.stepIndex + ' PLANNER (' + esc(inv.model || "-") + ')</strong><span class="muted">ctx=' + inv.contextTokens.toLocaleString() + ' · out=' + inv.outputTokens.toLocaleString() + ' · cache=' + (inv.cacheHitRate*100).toFixed(1) + '% · ' + fmtMs(inv.durationMs) + '</span></div>';
          const fullInv = DATA.fullSteps[String(inv.stepIndex)];
          const thinkText = fullInv?.thinking || inv.thinkingPreview;
          const replyText = fullInv?.content || inv.replyPreview;
          if (thinkText) html += '<details><summary class="muted">Thought summary (' + thinkText.length + ' chars)</summary><pre>' + esc(thinkText) + '</pre></details>';
          for (const tc of inv.toolCalls) {
            const tActive = playIdx >= 0 && allSteps[playIdx] === tc.stepIndex;
            const fullTool = tc.stepIndex != null ? DATA.fullSteps[String(tc.stepIndex)] : null;
            html += '<div class="tool ' + (tc.error ? 'err' : '') + '" style="' + (tActive ? 'outline:2px solid var(--accent)' : '') + '">';
            html += '<div class="row"><span><strong>#' + (tc.stepIndex ?? '?') + ' ' + esc(tc.name) + '</strong> <span class="badge">' + esc(tc.category) + '</span></span><span class="muted">' + fmtMs(tc.durationMs) + '</span></div>';
            html += '<div class="muted">' + esc(tc.argsSummary) + '</div>';
            if (tc.error) html += '<div style="color:var(--err)">Error: ' + esc(tc.error) + '</div>';
            const outText = fullTool?.content || tc.outputPreview;
            if (outText) html += '<details><summary class="muted">Output</summary><pre>' + esc(outText) + '</pre></details>';
            html += '</div>';
          }
          if (replyText) html += '<pre>' + esc(replyText) + '</pre>';
          html += '</div>';
        }
        html += '</div>';
      }
      root.innerHTML = html;
      document.getElementById("playPos").textContent = playIdx >= 0 ? ('Step #' + allSteps[playIdx] + ' (' + (playIdx+1) + '/' + allSteps.length + ')') : '';
    }
    document.getElementById("q").addEventListener("input", (e) => { query = e.target.value; render(); });
    document.getElementById("themeBtn").addEventListener("click", () => {
      const h = document.documentElement;
      h.setAttribute("data-theme", h.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
    document.getElementById("playBtn").addEventListener("click", () => {
      if (timer) { clearInterval(timer); timer = null; document.getElementById("playBtn").textContent = "Play Replay"; return; }
      if (allSteps.length === 0) return;
      if (playIdx < 0 || playIdx >= allSteps.length - 1) playIdx = 0;
      document.getElementById("playBtn").textContent = "Pause";
      render();
      timer = setInterval(() => {
        playIdx++;
        if (playIdx >= allSteps.length) { clearInterval(timer); timer = null; document.getElementById("playBtn").textContent = "Play Replay"; return; }
        render();
      }, 650);
    });
    render();
  </script>
</body>
</html>`;
}

export function exportTrajectoryToFile(
  conversationId,
  {
    format = "html",
    outputDir = null,
    brainRoots,
    pluginDataDir = getPluginDataDir(),
  } = {}
) {
  const traj = parseTrajectory(conversationId, {
    brainRoots,
    pluginDataDir,
    previewChars: 500,
    includeSubagentTree: true,
  });

  const normalizedFmt = format === "md" || format === "markdown" ? "markdown" : "html";
  let content = "";

  if (normalizedFmt === "markdown") {
    content = exportMarkdownReport(traj);
  } else {
    const fullStepsMap = new Map();
    const sessionPaths = resolveSessionPaths(conversationId, brainRoots);
    if (sessionPaths) {
      const parsedFull = parseJsonlDeduplicated(sessionPaths.transcriptFullPath);
      let budgetBytes = 4 * 1024 * 1024;
      for (const row of parsedFull.rows) {
        if (budgetBytes <= 0) break;
        const entry = {
          thinking: typeof row.thinking === "string" ? row.thinking.slice(0, 12000) : "",
          content: typeof row.content === "string" ? row.content.slice(0, 12000) : "",
        };
        budgetBytes -= entry.thinking.length + entry.content.length;
        fullStepsMap.set(row.step_index, entry);
      }
    }
    content = exportStandaloneHtmlReport(traj, fullStepsMap);
  }

  const destDir = resolveExportDir(traj, outputDir, pluginDataDir);
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = normalizedFmt === "markdown" ? "md" : "html";
  const fileName = `trajectory-${traj.meta.conversationId.slice(0, 8)}-${stamp}.${ext}`;
  const filePath = path.join(destDir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");

  return {
    conversationId: traj.meta.conversationId,
    format: normalizedFmt,
    filePath,
    fileUri: toFileUri(filePath),
    bytes,
    inlinePreview: normalizedFmt === "markdown" ? content.slice(0, 1500) : null,
  };
}
