import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readStdinSafe(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    if (process.stdin.readableEnded) finish();
  });
}

function resolveDataDir() {
  const candidates = [
    process.env.PLUGIN_DATA,
    process.env.TRAJ_PLUGIN_DATA,
    path.join(PLUGIN_ROOT, ".data"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return path.resolve(c.trim());
    }
  }
  return path.join(PLUGIN_ROOT, ".data");
}

function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]{4,128}$/.test(trimmed)) return null;
  return trimmed;
}

function truncateArgsPreview(args, maxValLen = 1500) {
  if (!args || typeof args !== "object") return args ?? null;
  if (Array.isArray(args)) {
    return args.slice(0, 20).map((item) => {
      if (typeof item === "string" && item.length > maxValLen) {
        return `${item.slice(0, maxValLen)}... [truncated ${item.length - maxValLen} chars]`;
      }
      return item;
    });
  }
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      out[k] =
        v.length > maxValLen
          ? `${v.slice(0, maxValLen)}... [truncated ${v.length - maxValLen} chars]`
          : v;
    } else if (Array.isArray(v) || (v && typeof v === "object")) {
      try {
        const s = JSON.stringify(v);
        out[k] =
          s.length > maxValLen
            ? `${s.slice(0, maxValLen)}... [truncated ${s.length - maxValLen} chars]`
            : v;
      } catch {
        out[k] = "[unserializable]";
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Fallback on Windows if target is briefly locked
    fs.copyFileSync(tmpPath, targetPath);
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

async function main() {
  const raw = await readStdinSafe(1000);
  let payload = {};
  try {
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  const nowMs = Date.now();
  const dataDir = resolveDataDir();
  const hookEventName = String(payload.hookEventName || "");
  const convId = sanitizeSessionId(payload.conversationId);

  const record = {
    tsMs: nowMs,
    tsIso: new Date(nowMs).toISOString(),
    event: hookEventName,
    conversationId: convId,
  };

  if (typeof payload.modelName === "string" && payload.modelName.trim()) {
    record.modelName = payload.modelName.trim();
  }
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    record.cwd = payload.cwd.trim();
  }
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    record.workspacePaths = payload.workspacePaths;
  }
  if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
    record.transcriptPath = payload.transcriptPath.trim();
  }
  if (
    typeof payload.artifactDirectoryPath === "string" &&
    payload.artifactDirectoryPath.trim()
  ) {
    record.artifactDirectoryPath = payload.artifactDirectoryPath.trim();
  }

  if (hookEventName === "PostToolUse") {
    if (typeof payload.stepIdx === "number") {
      record.stepIdx = payload.stepIdx;
    }
    if (payload.toolCall && typeof payload.toolCall === "object") {
      record.toolCall = {
        id: payload.toolCall.id ?? null,
        name: payload.toolCall.name ?? null,
        argsPreview: truncateArgsPreview(payload.toolCall.args),
      };
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      record.error = payload.error;
    }
  } else if (hookEventName === "PreInvocation" || hookEventName === "PostInvocation") {
    if (typeof payload.invocationNum === "number") {
      record.invocationNum = payload.invocationNum;
    }
    if (typeof payload.initialNumSteps === "number") {
      record.initialNumSteps = payload.initialNumSteps;
    }
  } else if (hookEventName === "Stop") {
    if (typeof payload.executionNum === "number") {
      record.executionNum = payload.executionNum;
    }
    if (typeof payload.terminationReason === "string") {
      record.terminationReason = payload.terminationReason;
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      record.error = payload.error;
    }
    if (typeof payload.fullyIdle === "boolean") {
      record.fullyIdle = payload.fullyIdle;
    }
    if (typeof payload.continuationActive === "boolean") {
      record.continuationActive = payload.continuationActive;
    }
  }

  try {
    if (convId) {
      const eventsDir = path.join(dataDir, "events");
      fs.mkdirSync(eventsDir, { recursive: true });
      const eventFile = path.join(eventsDir, `${convId}.jsonl`);
      fs.appendFileSync(eventFile, JSON.stringify(record) + "\n", "utf8");
    }

    const activePath = path.join(dataDir, "active-session.json");
    let prev = {};
    try {
      if (fs.existsSync(activePath)) {
        prev = JSON.parse(fs.readFileSync(activePath, "utf8")) || {};
      }
    } catch {
      prev = {};
    }

    const nextActive = {
      conversationId: convId || prev.conversationId || null,
      transcriptPath: record.transcriptPath || prev.transcriptPath || null,
      artifactDirectoryPath:
        record.artifactDirectoryPath || prev.artifactDirectoryPath || null,
      workspacePaths: record.workspacePaths || prev.workspacePaths || [],
      modelName: record.modelName || prev.modelName || null,
      cwd: record.cwd || prev.cwd || null,
      lastEvent: hookEventName || prev.lastEvent || null,
      updatedAtMs: nowMs,
      updatedAtIso: record.tsIso,
    };
    atomicWriteJson(activePath, nextActive);
  } catch {
    // Non-fatal: passive telemetry must never interrupt the agent loop
  }

  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
  process.exit(0);
});
