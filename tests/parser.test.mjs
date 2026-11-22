import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSessions } from "../server/compare.mjs";
import { exportTrajectoryToFile } from "../server/exporter.mjs";
import {
  buildForkHandoff,
  getStepDetail,
  parseTrajectory,
  searchTrajectory,
} from "../server/parser.mjs";
import { discoverBrainRoots, listAllSessions } from "../server/paths.mjs";

function makeFixtureEnv() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "traj-lens-test-"));
  const brainRoot = path.join(tmpRoot, "brain");
  const pluginData = path.join(tmpRoot, "plugin_data", "trajectory-lens");
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.mkdirSync(path.join(pluginData, "events"), { recursive: true });

  const convA = "11111111-1111-4111-8111-111111111111";
  const convB = "22222222-2222-4222-8222-222222222222";

  // Setup Session B (Child Subagent)
  const logsB = path.join(brainRoot, convB, ".system_generated", "logs");
  fs.mkdirSync(logsB, { recursive: true });
  const rowsB = [
    {
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      created_at: "2026-11-22T15:00:05Z",
      content: "Inspect target module",
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:06Z",
      model: "gemini-4-flash",
      input_tokens: 1200,
      cache_read_tokens: 0,
      output_tokens: 180,
      thinking: "Reading module",
      tool_calls: [{ name: "read_file", args: { Path: "C:\\repo\\mod.ts" } }],
    },
    {
      step_index: 2,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:06Z",
      content: "Created At: 2026-11-22T15:00:06Z\nCompleted At: 2026-11-22T15:00:07Z\nexport const x = 42;",
    },
    {
      step_index: 3,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:08Z",
      model: "gemini-4-flash",
      input_tokens: 400,
      cache_read_tokens: 1100,
      output_tokens: 90,
      content: "Module exports x=42.",
    },
  ];
  fs.writeFileSync(
    path.join(logsB, "transcript.jsonl"),
    rowsB.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(logsB, "transcript_full.jsonl"),
    rowsB.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  // Setup Session A (Root with duplicate step_index, parallel tools, errors, checkpoint, subagent, big output.txt)
  const sysA = path.join(brainRoot, convA, ".system_generated");
  const logsA = path.join(sysA, "logs");
  const step3Dir = path.join(sysA, "steps", "3");
  fs.mkdirSync(logsA, { recursive: true });
  fs.mkdirSync(step3Dir, { recursive: true });

  const bigOutput = "LINE_PREFIX\n" + "A".repeat(42000) + "\nTAIL_MARKER";
  fs.writeFileSync(path.join(step3Dir, "output.txt"), bigOutput, "utf8");

  const compactA = [
    {
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      created_at: "2026-11-22T15:00:00Z",
      content: "<USER_REQUEST>\nFix failing unit test in repo\n</USER_REQUEST>",
    },
    // Duplicate step_index 1 (RUNNING then DONE)
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "RUNNING",
      created_at: "2026-11-22T15:00:01Z",
      model: "gemini-4-neon-xhigh",
      input_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 0,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:02Z",
      model: "gemini-4-neon-xhigh",
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 320,
      thinking: "Initial short preview...",
      truncated_fields: ["thinking"],
      tool_calls: [
        { name: "read_file", args: { Path: "C:\\repo\\app.test.ts" } },
        { name: "run_command", args: { CommandLine: "npm test" } },
        { name: "invoke_subagent", args: { Role: "Module Reader", TypeName: "research", Model: "flash", Prompt: "Check mod.ts" } },
      ],
    },
    {
      step_index: 2,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:02Z",
      content: "Created At: 2026-11-22T15:00:02Z\nCompleted At: 2026-11-22T15:00:03.200Z\nimport { x } from './mod';",
    },
    {
      step_index: 3,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:02Z",
      content: "Created At: 2026-11-22T15:00:02Z\nCompleted At: 2026-11-22T15:00:04Z\nCommand exited with code 1\nTest failed (truncated)...",
      truncated_fields: ["content"],
    },
    {
      step_index: 4,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:03Z",
      content: `Created At: 2026-11-22T15:00:03Z\nCompleted At: 2026-11-22T15:00:04Z\nCreated the following subagent:\n{"conversationId": "${convB}"}`,
    },
    {
      step_index: 5,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:06Z",
      model: "gemini-4-neon-xhigh",
      input_tokens: 1500,
      cache_read_tokens: 9500,
      output_tokens: 200,
      thinking: "Retrying test after seeing exit 1",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    },
    {
      step_index: 6,
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:06Z",
      content: "Created At: 2026-11-22T15:00:06Z\nCompleted At: 2026-11-22T15:00:07Z\nCommand exited with code 1\nStill failing",
    },
    {
      step_index: 7,
      type: "SYSTEM_MESSAGE",
      source: "SYSTEM",
      status: "DONE",
      created_at: "2026-11-22T15:00:08Z",
      content: `[Message] sender=${convB} content=COMPLETED`,
    },
    {
      step_index: 8,
      type: "CHECKPOINT",
      source: "SYSTEM",
      status: "DONE",
      created_at: "2026-11-22T15:00:09Z",
      input_tokens: 4000,
      cache_read_tokens: 1000,
      output_tokens: 120,
      content: "Compacted earlier context",
    },
    {
      step_index: 9,
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-11-22T15:00:11Z",
      model: "gemini-4-neon-xhigh",
      input_tokens: 4200,
      cache_read_tokens: 800,
      output_tokens: 150,
      content: "All diagnosed. Ready for fix.",
    },
  ];

  const fullA = compactA.map((row) => {
    if (row.step_index === 1 && row.status === "DONE") {
      return {
        ...row,
        thinking: "Full untruncated thought summary: analyzing app.test.ts and dispatching subagent. </script> safety check",
      };
    }
    if (row.step_index === 3) {
      return {
        ...row,
        content: "Created At: 2026-11-22T15:00:02Z\nCompleted At: 2026-11-22T15:00:04Z\nCommand exited with code 1\nAssertionError: expected 41 to equal 42",
      };
    }
    return row;
  });

  fs.writeFileSync(
    path.join(logsA, "transcript.jsonl"),
    compactA.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(logsA, "transcript_full.jsonl"),
    fullA.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  // Hook events for convA
  const hookEvents = [
    {
      tsMs: 1700000000000,
      tsIso: "2026-11-22T15:00:00.000Z",
      event: "SessionStart",
      conversationId: convA,
      workspacePaths: [tmpRoot],
      modelName: "gemini-4-neon-xhigh",
    },
    {
      tsMs: 1700000004100,
      tsIso: "2026-11-22T15:00:04.100Z",
      event: "PostToolUse",
      conversationId: convA,
      stepIdx: 3,
      toolCall: { id: "toolu_cmd_01", name: "run_command", argsPreview: { CommandLine: "npm test" } },
      error: "exit status 1",
    },
    {
      tsMs: 1700000011200,
      tsIso: "2026-11-22T15:00:11.200Z",
      event: "Stop",
      conversationId: convA,
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    },
  ];
  fs.writeFileSync(
    path.join(pluginData, "events", `${convA}.jsonl`),
    hookEvents.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );

  return { tmpRoot, brainRoot, pluginData, convA, convB };
}

test("parser handles deduplication, parallel fan-out DAG, hooks, subagent tree, search, compare, and export", () => {
  const { tmpRoot, brainRoot, pluginData, convA, convB } = makeFixtureEnv();
  const brainRoots = discoverBrainRoots(pluginData, [{ surface: "test", path: brainRoot }]);

  try {
    const sessions = listAllSessions({
      brainRoots,
      activeConversationId: convA,
      pluginDataDir: pluginData,
      surface: "test",
    });
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((s) => s.conversationId === convA)?.title, "Fix failing unit test in repo");

    const traj = parseTrajectory(convA, {
      brainRoots,
      pluginDataDir: pluginData,
      includeSubagentTree: true,
    });

    // Deduplicated: 10 steps (0..9), not 11
    assert.equal(traj.meta.stepCount, 10);
    assert.equal(traj.meta.turnCount, 1);
    assert.equal(traj.meta.toolCallCount, 4);
    assert.equal(traj.meta.errorCount, 2);
    assert.equal(traj.meta.compactionCount, 1);
    assert.equal(traj.meta.subagentCount, 1);
    assert.equal(traj.meta.hasHookTelemetry, true);
    assert.equal(traj.tokenSummary.peakContextTokens, 11000);
    assert.equal(traj.turns[0].invocations[0].toolCalls[1].toolCallId, "toolu_cmd_01");
    assert.equal(traj.turns[0].invocations[0].toolCalls[0].durationMs, 1200);

    // DAG checks: parallel fan-out & join
    assert.ok(traj.dag.nodes.length >= 7);
    assert.ok(traj.dag.edges.some((e) => e.kind === "parallel"));
    assert.ok(traj.dag.edges.some((e) => e.kind === "join"));

    // Subagent tree & callback
    assert.equal(traj.subagentTree?.children.length, 1);
    assert.equal(traj.subagentTree?.children[0].conversationId, convB);
    assert.deepEqual(traj.subagentTree?.children[0].callbackStepIndices, [7]);

    // Insights: retry_loop + cache_drop + compaction + parallel_fanout
    const kinds = new Set(traj.analytics.insights.map((i) => i.kind));
    assert.ok(kinds.has("retry_loop"));
    assert.ok(kinds.has("cache_drop"));
    assert.ok(kinds.has("compaction"));
    assert.ok(kinds.has("parallel_fanout"));

    // Step detail: full thinking + paired GENERIC tool call + chunked external output.txt
    const detail1 = getStepDetail(convA, 1, { brainRoots, pluginDataDir: pluginData });
    assert.ok(detail1.thinking.includes("Full untruncated thought summary"));

    const detail2 = getStepDetail(convA, 2, { brainRoots, pluginDataDir: pluginData });
    assert.equal(detail2.pairedToolCall?.plannerStepIndex, 1);
    assert.equal(detail2.pairedToolCall?.name, "read_file");
    assert.equal(detail2.pairedToolCall?.args?.Path, "C:\\repo\\app.test.ts");

    const detail3 = getStepDetail(convA, 3, {
      brainRoots,
      pluginDataDir: pluginData,
      artifactOffset: 0,
      artifactLimit: 8192,
    });
    assert.equal(detail3.hookEvent?.toolCallId, "toolu_cmd_01");
    assert.equal(detail3.externalOutput?.hasMore, true);
    assert.ok(detail3.externalOutput?.text.startsWith("LINE_PREFIX"));

    // Search
    const searchRes = searchTrajectory(convA, {
      query: "AssertionError",
      brainRoots,
      pluginDataDir: pluginData,
    });
    assert.equal(searchRes.totalMatches, 1);
    assert.equal(searchRes.matches[0].stepIndex, 3);

    // Fork handoff
    const fork = buildForkHandoff(convA, 5, { brainRoots, pluginDataDir: pluginData });
    assert.ok(fork.prompt.includes("Fix failing unit test in repo"));
    assert.ok(fork.prompt.includes("Step #5"));

    // Compare
    const cmp = compareSessions(convA, convB, { brainRoots, pluginDataDir: pluginData });
    assert.equal(cmp.left.conversationId, convA);
    assert.equal(cmp.right.conversationId, convB);
    assert.ok(cmp.metrics.some((m) => m.key === "toolCalls"));

    // Export HTML & Markdown
    const expHtml = exportTrajectoryToFile(convA, {
      format: "html",
      outputDir: path.join(tmpRoot, "exports"),
      brainRoots,
      pluginDataDir: pluginData,
    });
    assert.ok(fs.existsSync(expHtml.filePath));
    const htmlStr = fs.readFileSync(expHtml.filePath, "utf8");
    assert.ok(htmlStr.includes("Trajectory Lens Offline Replay"));
    // Make sure embedded </script> in step 1 thinking was escaped
    assert.equal((htmlStr.match(/<\/script>/gi) || []).length, 1);

    const expMd = exportTrajectoryToFile(convA, {
      format: "markdown",
      outputDir: path.join(tmpRoot, "exports"),
      brainRoots,
      pluginDataDir: pluginData,
    });
    assert.ok(fs.existsSync(expMd.filePath));
    assert.ok(fs.readFileSync(expMd.filePath, "utf8").includes("Trajectory Lens Audit Report"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
