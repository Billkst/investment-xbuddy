import { env } from "cloudflare:workers";
import {
  newWorkspace,
  readWorkspaceToken,
  workspaceOwner,
} from "@/lib/research/workspace";
import {
  createRun,
  type RuntimeConfig,
  type Run,
  type Mode,
} from "@/lib/research/types";
import { advanceRun, applyAction } from "@/lib/research/engine";
import { toolRegistry } from "@/lib/research/tools";
import * as store from "@/lib/research/store";
export const dynamic = "force-dynamic";
function runtime(): RuntimeConfig {
  const values = env as unknown as Record<string, string | undefined>;
  const read = (key: string) => values[key] || process.env[key];
  return {
    llmBaseUrl: read("LLM_BASE_URL"),
    llmApiKey: read("LLM_API_KEY"),
    llmModel: read("LLM_MODEL"),
    fuyaoApiKey: read("FUYAO_API_KEY"),
    contextLimit: Number(read("CONTEXT_LIMIT")) || 7000,
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
      return json(await store.getRun(owner, id));
    }
    let cookie: string | undefined;
    if (!owner) {
      const workspace = await newWorkspace(request.url);
      await store.insertWorkspace(workspace.owner, workspace.expiresAt);
      owner = workspace.owner;
      cookie = workspace.cookie;
    }
    return json(
      {
        access: "anonymous",
        runs: await store.listRuns(owner),
        memories: await store.listMemories(owner),
        config: {
          model: !!(config.llmApiKey && config.llmBaseUrl && config.llmModel),
          modelName: config.llmModel ?? null,
          fuyao: !!config.fuyaoApiKey,
          publicMarket: true,
          contextLimit: config.contextLimit,
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
      if (!["demo", "live"].includes(String(body.mode)))
        throw new Error("请选择有效的数据模式");
      const maxCalls = Number(body.maxCalls ?? 10);
      if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 30)
        throw new Error("调用预算需为1至30的整数");
      const fault = (body.fault ?? "none") as Run["fault"];
      if (
        !["none", "tool_failure", "missing_data", "model_failure"].includes(
          fault,
        )
      )
        throw new Error("无效的故障演练类型");
      const run = createRun(
        goal,
        body.mode as Mode,
        await store.listMemories(owner),
        { maxCalls, fault },
      );
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
    if (body.action === "pause" && (await store.requestStop(owner, id)))
      return json({
        ...(await store.getRun(owner, id)),
        stopRequested: true,
      });
    const run = await store.withRunLock(
      owner,
      id,
      async (current, onProgress) =>
        body.action === "advance"
          ? advanceRun(current, { ...runtime(), onProgress })
          : applyAction(current, String(body.action), body),
    );
    return json({ run });
  } catch (e) {
    return failure(e);
  }
}
