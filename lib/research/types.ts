import type { IfindName } from "../integrations/ifind-catalog.ts";
import type { ModelSelection } from "./model-settings.ts";
export type Mode = "live" | "demo";
export type RunStatus =
  | "planning"
  | "needs_input"
  | "ready"
  | "running"
  | "paused"
  | "waiting_approval"
  | "completed"
  | "failed";
export type ToolName =
  | `ifind.${IfindName}`
  | "market.snapshot"
  | "market.history"
  | "finance.income"
  | "finance.cashflow"
  | "finance.valuation"
  | "analysis.metrics"
  | "research.report";
export interface Security {
  code: string;
  name: string;
  kind: "stock" | "index" | "topic";
}
export interface Intent {
  topic?: string;
  market?: string;
  broadScope?: boolean;
  securities: Security[];
  focus: string[];
  start: string;
  end: string;
  years: number;
  output: string;
  limitations: string[];
  clarification?: string;
}
export interface Step {
  id: string;
  title: string;
  tool: ToolName;
  security?: Security;
  parameters?: Record<string, unknown>;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempts: number;
  evidenceIds: string[];
  error?: string;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
}
export interface Evidence {
  id: string;
  stepId: string;
  security: Security;
  label: string;
  text?: string;
  evidenceKind?: "numeric" | "excerpt" | "discovery";
  value: number | null;
  unit: string;
  asOf: string;
  retrievedAt: string;
  source: string;
  sourceUrl: string;
  field: string;
  basis: string;
  quality: "verified" | "demo" | "missing" | "stale" | "unverified";
  raw: unknown;
  series?: { date: string; value: number }[];
  observations?: { date: string; value: number }[];
  formula?: string;
  inputIds?: string[];
  note?: string;
}
export interface ResearchEvent {
  id: string;
  at: string;
  type: string;
  message: string;
  detail?: string;
  durationMs?: number;
}
export interface Finding {
  kind: "fact" | "inference" | "uncertainty";
  text: string;
  evidenceIds: string[];
}
export interface Report {
  title: string;
  createdAt: string;
  summary: string;
  findings: Finding[];
  gaps: string[];
  questions: string[];
  mode: Mode;
}
export interface Approval {
  id: string;
  kind: "budget" | "scope";
  reason: string;
  current: number;
  proposed: number;
  planVersion: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: string;
  sourceRunId?: string;
}
export interface Run {
  id: string;
  goal: string;
  mode: Mode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  intent?: Intent;
  steps: Step[];
  events: ResearchEvent[];
  evidence: Evidence[];
  report?: Report;
  planner: "model" | "rules" | "pending" | "failed";
  modelRetryAt?: string;
  modelSelection?: ModelSelection;
  planVersion: number;
  approval?: Approval;
  scopeApproved: boolean;
  partialOnly?: boolean;
  pauseReason?: string;
  budget: { maxCalls: number; maxTokens: number; maxMs: number };
  usage: {
    calls: number;
    tokens: number;
    durationMs: number;
    modelCalls: number;
  };
  memoryContext: Memory[];
  context: {
    summary: string;
    compressedAt?: string;
    revision: number;
    beforeChars: number;
    afterChars: number;
    coveredSteps: string[];
  };
  checkpoint: {
    revision: number;
    at: string;
    completedSteps: string[];
    evidenceIds: string[];
    nextStepId?: string;
  };
  fault: "none" | "tool_failure" | "missing_data" | "model_failure";
  faultUsed: boolean;
}
export interface RuntimeConfig {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  fuyaoApiKey?: string;
  ifindMcpApiKey?: string;
  beforeFinancialCall?: () => Promise<void>;
  contextLimit: number;
  onProgress?: (run: Run) => Promise<void>;
  beforeModelCall?: (reservedTokens: number) => Promise<void>;
  settleModelCall?: (
    reservedTokens: number,
    actualTokens: number,
  ) => Promise<void>;
  onModelRateLimit?: (waitMs: number) => Promise<void>;
}
export interface PlannerResult {
  intent: Intent;
  steps: Pick<Step, "title" | "tool" | "security" | "parameters">[];
  model: boolean;
  warning?: string;
  blocked?: boolean;
  retryAfterMs?: number;
}
export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
export function event(
  run: Run,
  type: string,
  message: string,
  detail?: string,
  durationMs?: number,
) {
  run.events.push({
    id: uid("evt"),
    at: now(),
    type,
    message,
    detail,
    durationMs,
  });
  if (run.events.length > 250) run.events.splice(0, run.events.length - 250);
}
export function checkpoint(run: Run) {
  run.updatedAt = now();
  run.checkpoint = {
    revision: run.checkpoint.revision + 1,
    at: now(),
    completedSteps: run.steps
      .filter((s) => s.status === "succeeded" || s.status === "skipped")
      .map((s) => s.id),
    evidenceIds: run.evidence.map((e) => e.id),
    nextStepId: run.steps.find((s) => s.status === "pending")?.id,
  };
}
export class StopError extends Error {
  constructor() {
    super("用户已请求暂停");
    this.name = "StopError";
  }
}
export class BudgetError extends Error {
  constructor() {
    super("调用预算已用尽，需要确认追加预算");
    this.name = "BudgetError";
  }
}
export function consumeRequest(run: Run) {
  if (run.usage.calls >= run.budget.maxCalls) throw new BudgetError();
  run.usage.calls++;
}
export function createRun(
  goal: string,
  mode: Mode,
  memories: Memory[] = [],
  options: { maxCalls?: number; fault?: Run["fault"] } = {},
): Run {
  const stamp = now();
  const run: Run = {
    id: uid("run"),
    goal,
    mode,
    status: "planning",
    createdAt: stamp,
    updatedAt: stamp,
    steps: [],
    events: [],
    evidence: [],
    planner: "pending",
    planVersion: 0,
    scopeApproved: false,
    budget: {
      maxCalls: options.maxCalls ?? 10,
      maxTokens: 48000,
      maxMs: 240000,
    },
    usage: { calls: 0, tokens: 0, durationMs: 0, modelCalls: 0 },
    memoryContext: memories,
    context: {
      summary: "",
      revision: 0,
      beforeChars: 0,
      afterChars: 0,
      coveredSteps: [],
    },
    checkpoint: { revision: 0, at: stamp, completedSteps: [], evidenceIds: [] },
    fault: options.fault ?? "none",
    faultUsed: false,
  };
  event(
    run,
    "created",
    "研究线程已创建",
    mode === "demo"
      ? "演示模式：所有金融数值为构造数据。"
      : "真实数据模式：优先使用扶摇；公开行情为备用来源。",
  );
  if (memories.length)
    event(
      run,
      "memory",
      `已读取 ${memories.length} 条研究偏好`,
      memories.map((m) => m.text).join("；"),
    );
  return run;
}
