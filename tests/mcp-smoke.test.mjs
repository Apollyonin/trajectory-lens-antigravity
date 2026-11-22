import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function runHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(PLUGIN_ROOT, "hooks", "telemetry-hook.mjs")], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

class McpClientHelper {
  constructor(env) {
    this.child = spawn("node", [path.join(PLUGIN_ROOT, "server", "mcp-server.mjs")], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";

    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      }
    });

    this.child.stderr.on("data", (d) => (this.stderr += d.toString()));
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}. stderr: ${this.stderr}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close() {
    this.child.kill();
  }
}

test("telemetry-hook writes passive event ledger and mcp-server passes full JSON-RPC smoke sequence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "traj-mcp-smoke-"));
  const brainRoot = path.join(tmp, "brain");
  const pluginData = path.join(tmp, "plugin_data", "trajectory-lens");
  const conv1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const conv2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const writeSession = (cid, title, model) => {
    const logs = path.join(brainRoot, cid, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const rows = [
      {
        step_index: 0,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        created_at: "2026-11-22T15:10:00Z",
        content: title,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-22T15:10:01Z",
        model,
        input_tokens: 1800,
        cache_read_tokens: 200,
        output_tokens: 140,
        thinking: "Smoke check reasoning",
        tool_calls: [{ name: "read_file", args: { Path: "C:\\repo\\smoke.ts" } }],
        content: "Done",
      },
      {
        step_index: 2,
        type: "GENERIC",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-22T15:10:02Z",
        content: "Created At: 2026-11-22T15:10:01Z\nCompleted At: 2026-11-22T15:10:02Z\nexport const ok = true;",
      },
    ];
    fs.writeFileSync(path.join(logs, "transcript.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };

  writeSession(conv1, "Session One Smoke", "gemini-4-neon-xhigh");
  writeSession(conv2, "Session Two Smoke", "gemini-4-flash");

  const env = {
    TRAJ_PLUGIN_DATA: pluginData,
    TRAJ_BRAIN_ROOT: brainRoot,
  };

  const client = new McpClientHelper(env);
  try {
    // 1. Test hooks
    const r1 = await runHook({ hookEventName: "SessionStart", conversationId: conv1, workspacePaths: [tmp], modelName: "gemini-4-neon-xhigh" }, env);
    assert.equal(r1.code, 0);
    assert.equal(r1.out, "{}");

    const r2 = await runHook(
      {
        hookEventName: "PostToolUse",
        conversationId: conv1,
        stepIdx: 2,
        toolCall: { id: "toolu_99", name: "read_file", args: { Path: "C:\\repo\\smoke.ts" } },
      },
      env
    );
    assert.equal(r2.code, 0);
    assert.equal(r2.out, "{}");

    const r3 = await runHook({ hookEventName: "Stop", conversationId: conv1, terminationReason: "NO_TOOL_CALL", fullyIdle: true }, env);
    assert.equal(r3.code, 0);
    assert.equal(r3.out, "{}");

    const active = JSON.parse(fs.readFileSync(path.join(pluginData, "active-session.json"), "utf8"));
    assert.equal(active.conversationId, conv1);
    assert.equal(active.lastEvent, "Stop");

    // 2. Test MCP Server over stdio
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    });
    assert.equal(init.serverInfo.name, "trajectory-lens");
    client.notify("notifications/initialized", {});

    const toolsList = await client.request("tools/list", {});
    const openTool = toolsList.tools.find((x) => x.name === "open_trajectory_lens");
    assert.ok(openTool);
    assert.equal(openTool._meta?.ui?.resourceUri, "ui://trajectory-lens/app.html");
    const entryTypes = openTool._meta?.["com.google.antigravity/ui"]?.entrypoints?.map((e) => e.type);
    assert.deepEqual(entryTypes, ["aux_pane", "global"]);

    const appTools = toolsList.tools.filter((x) => x.name.startsWith("app_"));
    assert.ok(appTools.length >= 7);
    for (const at of appTools) {
      assert.deepEqual(at._meta?.ui?.visibility, ["app"]);
    }

    const resList = await client.request("resources/list", {});
    assert.equal(resList.resources[0].uri, "ui://trajectory-lens/app.html");

    const uiRes = await client.request("resources/read", { uri: "ui://trajectory-lens/app.html" });
    const htmlContent = uiRes.contents[0];
    assert.equal(htmlContent.mimeType, "text/html;profile=mcp-app");
    assert.ok(htmlContent.text.startsWith("<!doctype html>"));
    assert.ok(Buffer.byteLength(htmlContent.text, "utf8") < 10 * 1024 * 1024);

    const openCall = await client.request("tools/call", {
      name: "open_trajectory_lens",
      arguments: {},
    });
    assert.ok(Buffer.byteLength(JSON.stringify(openCall), "utf8") < 1024 * 1024);
    assert.equal(openCall.structuredContent.selectedConversationId, conv1);

    const summaryCall = await client.request("tools/call", {
      name: "trajectory_summary",
      arguments: { conversationId: conv1 },
    });
    assert.ok(summaryCall.content[0].text.includes("Session One Smoke"));

    const listCall = await client.request("tools/call", {
      name: "app_list_sessions",
      arguments: { surface: "custom" },
    });
    assert.equal(listCall.structuredContent.sessions.length, 2);
    const listedIds = new Set(listCall.structuredContent.sessions.map((s) => s.conversationId));
    assert.ok(listedIds.has(conv1));
    assert.ok(listedIds.has(conv2));

    const detailCall = await client.request("tools/call", {
      name: "app_get_step_detail",
      arguments: { conversationId: conv1, stepIndex: 1 },
    });
    assert.equal(detailCall.structuredContent.thinking, "Smoke check reasoning");

    const genericDetailCall = await client.request("tools/call", {
      name: "app_get_step_detail",
      arguments: { conversationId: conv1, stepIndex: 2 },
    });
    assert.equal(genericDetailCall.structuredContent.pairedToolCall?.name, "read_file");
    assert.equal(genericDetailCall.structuredContent.fileUris?.[0]?.uri, "file:///C:/repo/smoke.ts");

    const searchCall = await client.request("tools/call", {
      name: "app_search_trajectory",
      arguments: { conversationId: conv1, query: "Smoke check" },
    });
    assert.equal(searchCall.structuredContent.totalMatches, 1);

    const cmpCall = await client.request("tools/call", {
      name: "app_compare_sessions",
      arguments: { leftConversationId: conv1, rightConversationId: conv2 },
    });
    assert.equal(cmpCall.structuredContent.left.conversationId, conv1);
    assert.equal(cmpCall.structuredContent.right.conversationId, conv2);

    const forkCall = await client.request("tools/call", {
      name: "app_build_fork_handoff",
      arguments: { conversationId: conv1, upToStepIndex: 1 },
    });
    assert.ok(forkCall.structuredContent.prompt.includes("Session One Smoke"));

    const exportCall = await client.request("tools/call", {
      name: "app_export_trajectory",
      arguments: { conversationId: conv1, format: "html" },
    });
    assert.ok(fs.existsSync(exportCall.structuredContent.filePath));

    const pollCall = await client.request("tools/call", {
      name: "app_poll_revision",
      arguments: { conversationId: conv1 },
    });
    assert.ok(typeof pollCall.structuredContent.revision === "string");
  } finally {
    client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
