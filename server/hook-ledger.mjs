import fs from "node:fs";
import path from "node:path";
import { getPluginDataDir, SAFE_ID_RE } from "./paths.mjs";

/**
 * Reads passive hook telemetry logged by hooks/telemetry-hook.mjs for a conversation.
 * Returns indexed lookup structures keyed by stepIdx and invocation order.
 */
export function readHookEvents(pluginDataDir = getPluginDataDir(), conversationId) {
  const empty = {
    hasTelemetry: false,
    eventCount: 0,
    events: [],
    postToolByStepIdx: new Map(),
    invocations: [],
    stops: [],
    sessionMeta: null,
  };

  if (!conversationId || !SAFE_ID_RE.test(conversationId)) return empty;
  const eventPath = path.join(pluginDataDir, "events", `${conversationId}.jsonl`);
  if (!fs.existsSync(eventPath)) return empty;

  let text = "";
  try {
    text = fs.readFileSync(eventPath, "utf8");
  } catch {
    return empty;
  }

  const events = [];
  const postToolByStepIdx = new Map();
  const invocations = [];
  const openInvByNum = new Map();
  const stops = [];
  let sessionMeta = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    events.push(ev);

    if (!sessionMeta && (ev.workspacePaths || ev.cwd || ev.modelName)) {
      sessionMeta = {
        startedMs: ev.tsMs ?? null,
        workspacePaths: ev.workspacePaths || [],
        cwd: ev.cwd || null,
        modelName: ev.modelName || null,
      };
    } else if (sessionMeta) {
      if (Array.isArray(ev.workspacePaths) && ev.workspacePaths.length > 0) {
        sessionMeta.workspacePaths = ev.workspacePaths;
      }
      if (ev.cwd) sessionMeta.cwd = ev.cwd;
      if (ev.modelName) sessionMeta.modelName = ev.modelName;
    }

    if (ev.event === "PostToolUse" && typeof ev.stepIdx === "number") {
      postToolByStepIdx.set(ev.stepIdx, {
        toolCallId: ev.toolCall?.id ?? null,
        name: ev.toolCall?.name ?? null,
        argsPreview: ev.toolCall?.argsPreview ?? null,
        error: ev.error || null,
        completedMs: ev.tsMs ?? null,
        completedIso: ev.tsIso ?? null,
      });
    } else if (ev.event === "PreInvocation") {
      const num = ev.invocationNum ?? invocations.length;
      const entry = {
        invocationNum: num,
        initialNumSteps: ev.initialNumSteps ?? null,
        startedMs: ev.tsMs ?? null,
        endedMs: null,
        durationMs: null,
      };
      openInvByNum.set(num, entry);
      invocations.push(entry);
    } else if (ev.event === "PostInvocation") {
      const num = ev.invocationNum ?? invocations.length - 1;
      const entry = openInvByNum.get(num);
      if (entry && typeof ev.tsMs === "number") {
        entry.endedMs = ev.tsMs;
        if (typeof entry.startedMs === "number") {
          entry.durationMs = Math.max(0, ev.tsMs - entry.startedMs);
        }
      }
    } else if (ev.event === "Stop") {
      stops.push({
        tsMs: ev.tsMs ?? null,
        tsIso: ev.tsIso ?? null,
        executionNum: ev.executionNum ?? null,
        terminationReason: ev.terminationReason || null,
        error: ev.error || null,
        fullyIdle: typeof ev.fullyIdle === "boolean" ? ev.fullyIdle : null,
        continuationActive:
          typeof ev.continuationActive === "boolean" ? ev.continuationActive : null,
      });
    }
  }

  return {
    hasTelemetry: events.length > 0,
    eventCount: events.length,
    events,
    postToolByStepIdx,
    invocations,
    stops,
    sessionMeta,
  };
}
