export type Lang = "zh" | "en";
export type TabId = "ledger" | "graph" | "subagents" | "analytics" | "compare" | "sessions";
export type LedgerFilter = "all" | "planner" | "tools" | "errors" | "checkpoints" | "subagents" | "system";
export type InspectorSubTab = "overview" | "thinking" | "toolio" | "raw";

export interface SessionSummary {
  conversationId: string;
  surface: string;
  title: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  mtimeMs: number;
  fileBytes: number;
  approxSteps: number;
  userTurns: number | null;
  errorCount: number;
  compactionCount: number;
  hasSubagents: boolean;
  hasHookTelemetry: boolean;
  isActive?: boolean;
}

export interface ToolCallExec {
  indexInInvocation: number;
  plannerStepIndex: number;
  stepIndex: number | null;
  toolCallId: string | null;
  name: string;
  category: string;
  argsSummary: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  outputPreview: string;
  hasFullOutput: boolean;
  externalArtifact: string | null;
  fileRefs: string[];
  subagentSpawn?: {
    kind: string;
    childConversationId: string | null;
    role: string;
    typeName: string;
    model: string | null;
    workspace: string | null;
    promptPreview: string;
  } | null;
}

export interface InvocationItem {
  invocationIndex: number;
  stepIndex: number;
  model: string | null;
  status: string;
  createdAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  contextTokens: number;
  cacheHitRate: number;
  thinkingPreview: string;
  thinkingLength: number;
  replyPreview: string;
  replyLength: number;
  hasFullContent: boolean;
  toolCalls: ToolCallExec[];
}

export interface TurnItem {
  turnIndex: number;
  userStepIndex: number | null;
  userGoal: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  invocations: InvocationItem[];
  events: any[];
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  plainSummary?: { zh: string; en: string };
}

export interface DagNode {
  id: string;
  stepIndex: number;
  turnIndex: number;
  kind: string;
  category: string;
  label: string;
  sublabel?: string;
  status: string;
  durationMs: number | null;
  tokens: number | null;
  outputTokens?: number | null;
  cacheHitRate?: number;
  error?: string | null;
  childConversationId?: string | null;
  parallelIndex?: number;
  parallelTotal?: number;
}

export interface DagEdge {
  from: string;
  to: string;
  kind: string;
}

export interface SubagentNode {
  conversationId: string;
  title?: string;
  role: string;
  typeName: string;
  model: string | null;
  spawnStepIndex: number | null;
  callbackStepIndices: number[];
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  stepCount: number;
  toolCallCount: number;
  totalTokens: number;
  errorCount: number;
  children: SubagentNode[];
}

export interface TrajectoryData {
  meta: {
    conversationId: string;
    surface: string;
    title: string;
    model: string | null;
    modelsUsed: string[];
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    stepCount: number;
    turnCount: number;
    invocationCount: number;
    toolCallCount: number;
    errorCount: number;
    compactionCount: number;
    subagentCount: number;
    hasHookTelemetry: boolean;
    hookEventCount: number;
    stops: any[];
    workspacePaths: string[];
    partialTranscript: boolean;
    transcriptBytes: number;
    revision: string;
    limitations?: Record<string, unknown>;
  };
  tokenSummary: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    peakContextTokens: number;
    latestContextTokens: number;
    avgCacheHitRate: number;
    perInvocationSeries: Array<{
      stepIndex: number;
      turnIndex: number;
      ts: string | null;
      model: string | null;
      inputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      contextTokens: number;
      cacheHitRate: number;
    }>;
  };
  turns: TurnItem[];
  steps: any[];
  dag: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
  subagentRefs: any[];
  subagentTree: SubagentNode | null;
  analytics: {
    toolCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    slowestSteps: any[];
    fileTouchCounts: Array<{ filePath: string; count: number }>;
    checkpoints: any[];
    insights: Array<{
      id: string;
      severity: string;
      kind: string;
      titleZh: string;
      titleEn: string;
      detailZh: string;
      detailEn: string;
      stepIndices: number[];
    }>;
  };
}

export interface StepDetailData {
  conversationId: string;
  stepIndex: number;
  type: string;
  source: string | null;
  status: string | null;
  createdAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  thinking: string;
  content: string;
  error: string | null;
  toolCalls: Array<{ name: string; args?: any }>;
  pairedToolCall?: {
    plannerStepIndex: number;
    name: string;
    args?: any;
  } | null;
  media: Array<{ mime_type?: string; uri?: string }>;
  truncatedFields: string[];
  hookEvent: any;
  externalOutput: {
    filePath: string;
    totalBytes: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    text: string;
  } | null;
  fileUris?: Array<{ path: string; uri: string | null }>;
  rawStep: any;
}
