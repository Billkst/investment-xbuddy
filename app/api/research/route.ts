import { env } from "cloudflare:workers";
import {
  newWorkspace,
  readWorkspaceToken,
  workspaceOwner,
} from "@/lib/research/workspace";
import {
  createRun,
  event,
  checkpoint,
  type RuntimeConfig,
  type Run,
  type Mode,
} from "@/lib/research/types";
import { advanceRun, applyAction } from "@/lib/research/engine";
import { toolRegistry } from "@/lib/research/tools";
import { modelJson } from "@/lib/research/planner";
import { ModelRequestError } from "@/lib/research/plan-schema";
import {
  modelRuntime,
  parseModelSelection,
  type ModelSelection,
} from "@/lib/research/model-settings";
import * as store from "@/lib/research/store";
import {
  discoverIfind,
  credentialFingerprint,
  type IfindConnection,
} from "@/lib/integrations/ifind";
export const dynamic = "force-dynamic";
function limit(key: string, fallback: number, max: number) {
  const values = env as unknown as Record<string, string | undefined>;
  const n = Number(values[key] || process.env[key]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
function sharedLimits() {
  return {
    dailyCalls: limit("SHARED_MODEL_DAILY_CALLS", 40, 5000),
    dailyTokens: limit("SHARED_MODEL_DAILY_TOKENS", 180000, 2000000),
    minuteCalls: limit("SHARED_MODEL_MINUTE_CALLS", 6, 60),
    workspaceDailyCalls: limit("SHARED_MODEL_WORKSPACE_DAILY_CALLS", 20, 100),
  };
}
function configuredModel(
  owner: string,
  selection: ModelSelection,
  credential?: unknown,
) {
  const config = modelRuntime(selection, credential, runtime());
  let reservationBuckets: string[] = [];
  const cooldownBucket = `cooldown:${selection.source === "site" ? "site" : owner}:${config.llmModel ?? "unset"}`;
  config.onModelRateLimit = (waitMs) =>
    store.setModelCooldown(cooldownBucket, waitMs);
  config.beforeFinancialCall = async () => {
    const day = Math.floor(Date.now() / 86400000),
      minute = Math.floor(Date.now() / 60000);
    await store.reserveModelBudget(
      [
        {
          bucket: `ifind:data:minute:${minute}`,
          callLimit: 12,
          tokenLimit: 1,
          expiresAt: (minute + 2) * 60000,
        },
        {
          bucket: `ifind:data:day:${day}`,
          callLimit: 200,
          tokenLimit: 1,
          expiresAt: (day + 2) * 86400000,
        },
        {
          bucket: `ifind:data:workspace:${owner}:${day}`,
          callLimit: 40,
          tokenLimit: 1,
          expiresAt: (day + 2) * 86400000,
        },
      ],
      0,
      "iFinD 取数已达到站点或工作台保护额度，请稍后重试。",
    );
  };
  config.beforeModelCall = async (tokens) => {
    const retryAt = await store.modelCooldownAt(cooldownBucket);
    if (retryAt)
      throw new ModelRequestError(
        `模型服务正在恢复，请约 ${Math.ceil((retryAt - Date.now()) / 1000)} 秒后重试。`,
        "transient",
        Math.max(1, retryAt - Date.now()),
      );
    const now = Date.now(),
      day = Math.floor(now / 86400000),
      minute = Math.floor(now / 60000);
    const shared = selection.source === "site",
      limits = sharedLimits();
    const buckets = [
      {
        bucket: `workspace:${shared ? "shared" : "personal"}:${owner}:${day}`,
        callLimit: shared ? limits.workspaceDailyCalls : 60,
        tokenLimit: 250000,
        expiresAt: (day + 2) * 86400000,
      },
    ];
    if (shared)
      buckets.push(
        {
          bucket: `shared:day:${day}`,
          callLimit: limits.dailyCalls,
          tokenLimit: limits.dailyTokens,
          expiresAt: (day + 2) * 86400000,
        },
        {
          bucket: `shared:minute:${minute}`,
          callLimit: limits.minuteCalls,
          tokenLimit: 40000,
          expiresAt: (minute + 2) * 60000,
        },
      );
    await store.reserveModelBudget(buckets, tokens);
    reservationBuckets = buckets.map((b) => b.bucket);
  };
  config.settleModelCall = async (reserved, actual) => {
    const buckets = reservationBuckets;
    reservationBuckets = [];
    await store.settleModelBudget(buckets, reserved, actual);
  };
  return config;
}
function runtime(): RuntimeConfig {
  const values = env as unknown as Record<string, string | undefined>;
  const read = (key: string) => values[key] || process.env[key];
  return {
    llmBaseUrl: read("LLM_BASE_URL"),
    llmApiKey: read("LLM_API_KEY"),
    llmModel: read("LLM_MODEL"),
    fuyaoApiKey: read("FUYAO_API_KEY"),
    ifindMcpApiKey: read("IFIND_MCP_API_KEY"),
    contextLimit: limit("CONTEXT_LIMIT", 16000, 128000),
  };
}
function json(data: unknown, status = 200, cookie?: string) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "服务暂时不可用";
  console.error(
    "Research request failed:",
    message.replace(/(Bearer|X-api-key)[^\s,]+/gi, "[redacted]"),
  );
  if (message.startsWith("BUSY:"))
    return json({ error: message.slice(5) }, 409);
  if (/no such table|binding|D1_|SQLITE_|database|持久化/.test(message))
    return json(
      { error: "研究存储暂时不可用。你的输入仍保留，请稍后重试。" },
      503,
    );
  return json({ error: message.slice(0, 350) }, 400);
}
async function ownerFor(request: Request): Promise<string | null> {
  const token = readWorkspaceToken(request);
  if (!token) return null;
  const owner = await workspaceOwner(token);
  return (await store.hasWorkspace(owner)) ? owner : null;
}
function sessionRequired() {
  return json(
    {
      error:
        "工作台会话尚未建立或已清空。请刷新页面，并允许本站使用 Cookie；也可在独立浏览器窗口打开站点。",
    },
    428,
  );
}
export async function GET(request: Request) {
  try {
    if (request.headers.get("Sec-Fetch-Site") === "cross-site")
      return json({ error: "不允许跨站读取工作台" }, 403);
    const config = runtime();
    let owner = await ownerFor(request);
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      if (!owner) return sessionRequired();
      const saved = await store.getRun(owner, id);
      if (saved.run.mode === "demo")
        return json({ error: "旧版演示研究已归档，请新建真实数据研究。" }, 410);
      return json(saved);
    }
    let cookie: string | undefined;
    if (!owner) {
      const workspace = await newWorkspace(request.url);
      await store.insertWorkspace(workspace.owner, workspace.expiresAt);
      owner = workspace.owner;
      cookie = workspace.cookie;
    }
    const ifindConnection = config.ifindMcpApiKey
      ? await store.getServiceConnection<IfindConnection>(
          "ifind",
          await credentialFingerprint(config.ifindMcpApiKey),
        )
      : null;
    if (ifindConnection) ifindConnection.researchEnabled = true;
    return json(
      {
        access: "anonymous",
        runs: (await store.listRuns(owner)).filter(
          (run) => run.mode === "live",
        ),
        memories: await store.listMemories(owner),
        ifindConnection,
        config: {
          model: !!(config.llmApiKey && config.llmBaseUrl && config.llmModel),
          modelName: config.llmModel ?? null,
          fuyao: !!config.fuyaoApiKey,
          ifind: !!config.ifindMcpApiKey,
          publicMarket: true,
          contextLimit: config.contextLimit,
          sharedLimits: sharedLimits(),
        },
        tools: toolRegistry,
      },
      200,
      cookie,
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("Origin");
    if (
      request.headers.get("Sec-Fetch-Site") === "cross-site" ||
      (origin && origin !== new URL(request.url).origin)
    )
      return json({ error: "不允许跨站写入" }, 403);
    if (!request.headers.get("Content-Type")?.includes("application/json"))
      return json({ error: "仅接受 JSON 请求" }, 415);
    const owner = await ownerFor(request);
    if (!owner) return sessionRequired();
    const text = await request.text();
    if (text.length > 12000) return json({ error: "请求内容过长" }, 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.action === "ifind_connect") {
      const key = runtime().ifindMcpApiKey;
      if (!key)
        throw new Error(
          "请由维护者在服务端配置 IFIND_MCP_API_KEY，然后验证连接。",
        );
      const fingerprint = await credentialFingerprint(key);
      const cached = await store.getServiceConnection<IfindConnection>(
        "ifind",
        fingerprint,
      );
      if (cached && Date.now() - Date.parse(cached.checkedAt) < 30000)
        return json({ connection: cached });
      const minute = Math.floor(Date.now() / 60000),
        day = Math.floor(Date.now() / 86400000);
      await store.reserveModelBudget(
        [
          {
            bucket: `ifind:minute:${minute}`,
            callLimit: 6,
            tokenLimit: 1,
            expiresAt: (minute + 2) * 60000,
          },
          {
            bucket: `ifind:day:${day}`,
            callLimit: 60,
            tokenLimit: 1,
            expiresAt: (day + 2) * 86400000,
          },
        ],
        0,
        "iFinD 连接验证已达到站点频率限制，请稍后重试。",
      );
      let connection: IfindConnection;
      try {
        connection = await discoverIfind(key);
      } catch (error) {
        // Only our bounded messages are public; never return upstream bodies or transport details.
        const message =
          error instanceof Error &&
          /^(iFinD|此 iFinD|无法连接 iFinD)/.test(error.message)
            ? error.message.replaceAll(key, "[redacted]").slice(0, 350)
            : "iFinD 连接中断，请稍后重新验证。";
        connection = {
          status: "error",
          checkedAt: new Date().toISOString(),
          message,
          tools: [],
          complete: false,
          researchEnabled: false,
        };
      }
      await store.saveServiceConnection("ifind", fingerprint, connection);
      return json({ connection });
    }
    if (body.action === "model_test") {
      const selection = parseModelSelection(body.modelSelection);
      const config = configuredModel(owner, selection, body.modelCredential);
      if (!config.llmApiKey || !config.llmBaseUrl || !config.llmModel)
        throw new Error(
          "当前来源未配置模型服务，请填写个人密钥或由维护者配置共享服务。",
        );
      const probe = createRun("验证模型 JSON 连接", "demo");
      const result = (await modelJson(
        probe,
        config,
        '仅返回 JSON 对象 {"ok":true}，不添加其他文字。',
        "请验证 JSON 输出。",
        256,
      )) as { ok?: boolean };
      if (result?.ok !== true)
        throw new Error(
          "服务已响应，但未通过 JSON 输出检查；请确认模型支持 JSON 模式。",
        );
      return json({
        ok: true,
        model: config.llmModel,
        source: selection.source,
      });
    }
    if (body.action === "workspace_clear") {
      await store.clearWorkspace(owner);
      const workspace = await newWorkspace(request.url);
      await store.insertWorkspace(workspace.owner, workspace.expiresAt);
      return json({ ok: true }, 200, workspace.cookie);
    }
    if (body.action === "create") {
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      if (goal.length < 4 || goal.length > 2000)
        throw new Error("研究目标需为4至2000字");
      const mode = body.mode ?? "live";
      if (mode !== "live")
        throw new Error("研究空间仅使用真实金融数据，构造数据入口已移除。");
      const maxCalls = Number(body.maxCalls ?? 10);
      if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 30)
        throw new Error("调用预算需为1至30的整数");
      const fault = (body.fault ?? "none") as Run["fault"];
      if (fault !== "none") throw new Error("故障演练仅用于本地自动化测试。");
      if (
        !["none", "tool_failure", "missing_data", "model_failure"].includes(
          fault,
        )
      )
        throw new Error("无效的故障演练类型");
      const run = createRun(
        goal,
        mode as Mode,
        await store.listMemories(owner),
        { maxCalls, fault },
      );
      run.modelSelection = parseModelSelection(body.modelSelection);
      modelRuntime(run.modelSelection, body.modelCredential, runtime());
      await store.insertRun(owner, run);
      return json({ run }, 201);
    }
    if (body.action === "memory_add") {
      const value = typeof body.text === "string" ? body.text.trim() : "";
      if (!value || value.length > 300) throw new Error("偏好需为1至300字");
      if (body.sourceRunId) await store.getRun(owner, String(body.sourceRunId));
      return json({
        memory: await store.addMemory(
          owner,
          value,
          typeof body.sourceRunId === "string" ? body.sourceRunId : undefined,
        ),
      });
    }
    if (body.action === "memory_delete") {
      await store.deleteMemory(owner, String(body.memoryId ?? ""));
      return json({ ok: true });
    }
    const id = String(body.id ?? "");
    if (!/^run_[a-f0-9]{16}$/.test(id)) throw new Error("无效的研究ID");
    if (body.action === "pause") {
      const current = await store.getRun(owner, id);
      if (current.run.mode === "demo")
        throw new Error("旧版演示研究已归档，请新建真实数据研究。");
      if (await store.requestStop(owner, id))
        return json({
          ...(await store.getRun(owner, id)),
          stopRequested: true,
        });
    }
    const run = await store.withRunLock(
      owner,
      id,
      async (current, onProgress) => {
        if (current.mode === "demo")
          throw new Error("旧版演示研究已归档，请新建真实数据研究。");
        if (body.action === "model_rules") {
          current.modelSelection = { source: "rules" };
          if (current.planner === "failed") {
            current.status = "planning";
            current.planner = "pending";
            current.pauseReason = undefined;
            current.modelRetryAt = undefined;
          }
          event(current, "model_source", "用户选择规则模式继续研究");
          checkpoint(current);
          return current;
        }
        return body.action === "advance"
          ? advanceRun(current, {
              ...configuredModel(
                owner,
                current.modelSelection ?? { source: "site" },
                body.modelCredential,
              ),
              onProgress,
            })
          : applyAction(current, String(body.action), body);
      },
    );
    return json({ run });
  } catch (e) {
    return failure(e);
  }
}
