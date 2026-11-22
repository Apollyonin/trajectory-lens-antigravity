import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

const sessionSummaryCache = new Map();

export function getPluginRoot() {
  const envRoot = process.env.TRAJ_PLUGIN_ROOT?.trim();
  if (envRoot) return path.resolve(envRoot);
  return path.resolve(__dirname, "..");
}

export function getPluginDataDir() {
  const candidates = [
    process.env.TRAJ_PLUGIN_DATA,
    process.env.PLUGIN_DATA,
    path.join(getPluginRoot(), ".data"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return path.resolve(c.trim());
    }
  }
  return path.join(getPluginRoot(), ".data");
}

function normalizePathKey(p) {
  try {
    return fs.realpathSync(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
}

export function discoverBrainRoots(pluginDataDir = getPluginDataDir(), extraRoots = []) {
  const candidates = [];

  for (const r of extraRoots || []) {
    if (!r) continue;
    if (typeof r === "string") {
      candidates.push({ surface: "custom", path: path.resolve(r) });
    } else if (typeof r === "object" && r.path) {
      candidates.push({ surface: r.surface || "custom", path: path.resolve(r.path) });
    }
  }

  if (process.env.TRAJ_BRAIN_ROOT?.trim()) {
    candidates.push({
      surface: "custom",
      path: path.resolve(process.env.TRAJ_BRAIN_ROOT.trim()),
    });
  }

  if (pluginDataDir) {
    let cur = path.resolve(pluginDataDir);
    for (let i = 0; i < 6; i++) {
      if (path.basename(cur).toLowerCase() === "plugin_data") {
        const siblingBrain = path.join(path.dirname(cur), "brain");
        candidates.push({ surface: "app", path: siblingBrain });
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const home = os.homedir();
  candidates.push(
    { surface: "app", path: path.join(home, ".gemini", "antigravity", "brain") },
    { surface: "cli", path: path.join(home, ".gemini", "antigravity-cli", "brain") },
    { surface: "ide", path: path.join(home, ".gemini", "antigravity-ide", "brain") }
  );

  const seen = new Set();
  const roots = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    const key = normalizePathKey(c.path);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(c);
  }
  return roots;
}

export function readActiveSession(pluginDataDir = getPluginDataDir()) {
  const activePath = path.join(pluginDataDir, "active-session.json");
  try {
    if (!fs.existsSync(activePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(activePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function cleanUserInputTitle(rawContent, maxLen = 90) {
  if (typeof rawContent !== "string" || !rawContent) return null;
  let text = rawContent;
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
      .replace(/<\/?USER_REQUEST>/gi, "");
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.length > maxLen
    ? `${singleLine.slice(0, maxLen - 1)}…`
    : singleLine;
}

export function resolveSessionPaths(conversationId, brainRoots) {
  if (!conversationId || !SAFE_ID_RE.test(conversationId)) return null;
  const roots = brainRoots && brainRoots.length > 0 ? brainRoots : discoverBrainRoots();

  for (const root of roots) {
    const brainDir = path.join(root.path, conversationId);
    const logsDir = path.join(brainDir, ".system_generated", "logs");
    const transcriptPath = path.join(logsDir, "transcript.jsonl");
    const transcriptFullPath = path.join(logsDir, "transcript_full.jsonl");
    const hasCompact = fs.existsSync(transcriptPath);
    const hasFull = fs.existsSync(transcriptFullPath);
    if (hasCompact || hasFull) {
      return {
        conversationId,
        surface: root.surface,
        brainDir,
        sysGenDir: path.join(brainDir, ".system_generated"),
        transcriptPath: hasCompact ? transcriptPath : transcriptFullPath,
        transcriptFullPath: hasFull ? transcriptFullPath : transcriptPath,
        stepsDir: path.join(brainDir, ".system_generated", "steps"),
        tasksDir: path.join(brainDir, ".system_generated", "tasks"),
      };
    }
  }
  return null;
}

function readWindowLines(filePath, offsetBytes, lengthBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(lengthBytes);
    const n = fs.readSync(fd, buf, 0, lengthBytes, offsetBytes);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function extractQuickSummary(sessionPaths, pluginDataDir) {
  const target = sessionPaths.transcriptPath;
  const stat = fs.statSync(target);
  const cacheKey = `${target}`;
  const cached = sessionSummaryCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.summary;
  }

  let headLines = [];
  let tailLines = [];
  if (stat.size <= 256 * 1024) {
    const all = fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
    headLines = all;
    tailLines = all;
  } else {
    const headRaw = readWindowLines(target, 0, 96 * 1024);
    const tailOffset = Math.max(0, stat.size - 96 * 1024);
    const tailRaw = readWindowLines(target, tailOffset, Math.min(96 * 1024, stat.size));
    headLines = headRaw.split(/\r?\n/).filter(Boolean);
    const splitTail = tailRaw.split(/\r?\n/);
    if (tailOffset > 0) splitTail.shift();
    tailLines = splitTail.filter(Boolean);
  }

  let title = null;
  let startedAt = null;
  let endedAt = null;
  let latestModel = null;
  let lastStepIndex = 0;
  let errorCount = 0;
  let compactionCount = 0;
  let hasSubagents = false;
  let userTurns = 0;

  const parseLine = (l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  };

  for (const l of headLines) {
    const o = parseLine(l);
    if (!o) continue;
    if (!startedAt && o.created_at) startedAt = o.created_at;
    if (!title && o.type === "USER_INPUT" && o.content) {
      title = cleanUserInputTitle(o.content);
    }
    if (o.model) latestModel = o.model;
  }

  const seenStep = new Set();
  const scanForStats = stat.size <= 256 * 1024 ? headLines : tailLines;
  for (const l of scanForStats) {
    const o = parseLine(l);
    if (!o) continue;
    if (o.created_at) endedAt = o.created_at;
    if (o.model) latestModel = o.model;
    if (typeof o.step_index === "number") {
      if (o.step_index > lastStepIndex) lastStepIndex = o.step_index;
      if (seenStep.has(o.step_index)) continue;
      seenStep.add(o.step_index);
    }
    if (o.type === "USER_INPUT") userTurns++;
    if (o.type === "ERROR_MESSAGE" || o.status === "ERROR" || o.error) errorCount++;
    if (o.type === "CHECKPOINT" || o.type === "COMPACTION") compactionCount++;
    if (
      Array.isArray(o.tool_calls) &&
      o.tool_calls.some((tc) => tc?.name === "invoke_subagent")
    ) {
      hasSubagents = true;
    }
  }

  const hookFile = path.join(pluginDataDir, "events", `${sessionPaths.conversationId}.jsonl`);
  const hasHookTelemetry = fs.existsSync(hookFile);

  const summary = {
    conversationId: sessionPaths.conversationId,
    surface: sessionPaths.surface,
    title: title || `Session ${sessionPaths.conversationId.slice(0, 8)}`,
    model: latestModel,
    startedAt,
    endedAt,
    mtimeMs: stat.mtimeMs,
    fileBytes: stat.size,
    approxSteps: lastStepIndex + 1,
    userTurns: stat.size <= 256 * 1024 ? userTurns : null,
    errorCount,
    compactionCount,
    hasSubagents,
    hasHookTelemetry,
  };

  sessionSummaryCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    summary,
  });
  return summary;
}

export function listAllSessions({
  brainRoots,
  activeConversationId = null,
  limit = 50,
  query = "",
  surface = "all",
  pluginDataDir = getPluginDataDir(),
} = {}) {
  const roots = brainRoots && brainRoots.length > 0 ? brainRoots : discoverBrainRoots(pluginDataDir);
  const candidates = [];
  const seenIds = new Set();

  for (const root of roots) {
    if (surface && surface !== "all" && root.surface !== surface) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !SAFE_ID_RE.test(ent.name)) continue;
      if (seenIds.has(ent.name)) continue;
      const logsDir = path.join(root.path, ent.name, ".system_generated", "logs");
      const compact = path.join(logsDir, "transcript.jsonl");
      const full = path.join(logsDir, "transcript_full.jsonl");
      const target = fs.existsSync(compact) ? compact : fs.existsSync(full) ? full : null;
      if (!target) continue;
      try {
        const st = fs.statSync(target);
        if (!st.isFile() || st.size === 0) continue;
        seenIds.add(ent.name);
        candidates.push({
          conversationId: ent.name,
          surface: root.surface,
          brainDir: path.join(root.path, ent.name),
          sysGenDir: path.join(root.path, ent.name, ".system_generated"),
          transcriptPath: target,
          transcriptFullPath: fs.existsSync(full) ? full : compact,
          stepsDir: path.join(root.path, ent.name, ".system_generated", "steps"),
          tasksDir: path.join(root.path, ent.name, ".system_generated", "tasks"),
          mtimeMs: st.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const q = String(query || "").trim().toLowerCase();
  const maxItems = Math.max(1, Math.min(200, Number(limit) || 50));
  const out = [];

  for (const c of candidates) {
    try {
      const summary = extractQuickSummary(c, pluginDataDir);
      if (q) {
        const hay = `${summary.conversationId} ${summary.title} ${summary.model || ""} ${summary.surface}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push({
        ...summary,
        isActive: Boolean(activeConversationId && summary.conversationId === activeConversationId),
      });
      if (out.length >= maxItems) break;
    } catch {
      continue;
    }
  }

  return out;
}

export function resolveLatestConversationId({
  brainRoots,
  pluginDataDir = getPluginDataDir(),
} = {}) {
  const active = readActiveSession(pluginDataDir);
  if (active?.conversationId) {
    const resolved = resolveSessionPaths(active.conversationId, brainRoots);
    if (resolved) return active.conversationId;
  }
  const sessions = listAllSessions({
    brainRoots,
    limit: 1,
    pluginDataDir,
  });
  return sessions.length > 0 ? sessions[0].conversationId : null;
}

export function toFileUri(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  let normalized = path.resolve(filePath).replace(/\\/g, "/");
  // Drive letter Windows path: C:/foo/bar -> file:///C:/foo/bar
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const rest = normalized
      .slice(2)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `file:///${drive}${rest}`;
  }
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return (
    "file://" +
    normalized
      .split("/")
      .map((seg, idx) => (idx === 0 ? "" : encodeURIComponent(seg)))
      .join("/")
  );
}
