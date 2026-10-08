// Fixed-endpoint MCP transport; the research layer validates tool names and arguments.
export const IFIND_ENDPOINT =
  "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-mcp";
const supportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
export interface IfindTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface IfindConnection {
  status: "connected" | "error";
  checkedAt: string;
  message?: string;
  serverName?: string;
  protocolVersion?: string;
  tools: IfindTool[];
  complete: boolean;
  researchEnabled: boolean;
}
type Rpc = {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number };
};
const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export async function credentialFingerprint(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
function rpcResult(
  message: unknown,
  id: string | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(message) || (id !== undefined && message.id !== id)) return;
  const rpc = message as Rpc;
  if (rpc.jsonrpc !== "2.0") throw new Error("iFinD 返回了无效的 MCP 消息。");
  if (rpc.error)
    throw new Error(
      `iFinD MCP 请求失败（协议错误码 ${Number.isInteger(rpc.error.code) ? rpc.error.code : "未知"}），请核对账户权限。`,
    );
  if (!isRecord(rpc.result)) throw new Error("iFinD 返回的 MCP 结果格式无效。");
  return rpc.result;
}
export async function readRpcResponse(
  response: Response,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("iFinD 返回空响应。");
  const sse = response.headers
    .get("Content-Type")
    ?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000)
        throw new Error("iFinD 工具清单响应过大，已停止读取。");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (sse) {
        // Normalize after buffering: CRLF may be split across chunks.
        const normalized = buffer.replace(/\r\n/g, "\n");
        const events = normalized.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const payload = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!payload) continue;
          let message: unknown;
          try {
            message = JSON.parse(payload);
          } catch {
            throw new Error("iFinD 返回无效的 SSE 数据。");
          }
          const result = rpcResult(message, id);
          if (result) return result;
        }
      }
    }
    buffer += decoder.decode();
    if (!sse) {
      let message: unknown;
      try {
        message = JSON.parse(buffer);
      } catch {
        throw new Error("iFinD 返回的内容不是有效 JSON。");
      }
      const result = rpcResult(message, id);
      if (result) return result;
    }
    throw new Error("iFinD 未返回与请求匹配的 MCP 结果。");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function withIfindSession<T>(
  key: string,
  work: (
    post: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
    init: Record<string, unknown>,
    protocol: string,
  ) => Promise<T>,
  timeoutMs = 25000,
): Promise<T> {
  if (!/^[\x21-\x7e]{8,2048}$/.test(key))
    throw new Error(
      "iFinD MCP 密钥为空或格式无效，请在服务端配置 IFIND_MCP_API_KEY。",
    );
  const signal = AbortSignal.timeout(timeoutMs);
  let session = "",
    protocol = supportedVersions[0];
  const headers = () => ({
    Authorization: key,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(session ? { "Mcp-Session-Id": session } : {}),
    "MCP-Protocol-Version": protocol,
  });
  async function post(
    method: string,
    params?: Record<string, unknown>,
    notification = false,
  ) {
    const id = crypto.randomUUID();
    let response: Response;
    try {
      response = await fetch(IFIND_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(!notification ? { id } : {}),
          method,
          ...(params ? { params } : {}),
        }),
        signal,
      });
    } catch {
      throw new Error(
        signal.aborted
          ? "iFinD MCP 连接超时，请稍后重试。"
          : "无法连接 iFinD MCP 服务，请检查网络后重试。",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new Error("iFinD MCP 认证失败，请检查专用密钥和账户权限。");
      if (response.status === 429)
        throw new Error("iFinD MCP 请求过快或额度不足，请稍后重试。");
      if (response.status === 404 && session)
        throw new Error("iFinD 会话已失效，请重新验证连接。");
      throw new Error(`iFinD MCP 返回 HTTP ${response.status}，连接未完成。`);
    }
    if (notification) {
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        return {};
      }
      // iFinD returns HTTP 200 with its own generated ID and explicit ack.
      // Validate that observed extension; never swallow JSON-RPC errors.
      const acknowledgement = await readRpcResponse(response, undefined);
      if (
        response.status !== 200 ||
        acknowledgement._notification_handled !== true
      )
        throw new Error("iFinD 未正确确认初始化通知，连接未完成。");
      return {};
    }
    if (method === "initialize") {
      const assigned = response.headers.get("Mcp-Session-Id");
      if (assigned && !/^[\x21-\x7e]{1,2048}$/.test(assigned))
        throw new Error("iFinD 返回了无效的会话标识。");
      session = assigned ?? "";
    }
    return readRpcResponse(response, id);
  }
  try {
    const init = await post("initialize", {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "investment-xbuddy", version: "0.1.0" },
    });
    if (
      typeof init.protocolVersion !== "string" ||
      !supportedVersions.includes(init.protocolVersion)
    )
      throw new Error("iFinD 协议版本暂不兼容，连接未完成。");
    protocol = init.protocolVersion;
    if (!isRecord(init.capabilities) || !isRecord(init.capabilities.tools))
      throw new Error("此 iFinD 服务没有开放工具发现能力。");
    await post("notifications/initialized", undefined, true);
    return await work(post, init, protocol);
  } finally {
    if (session)
      await fetch(IFIND_ENDPOINT, {
        method: "DELETE",
        headers: headers(),
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
  }
}

export async function discoverIfind(key: string): Promise<IfindConnection> {
  return withIfindSession(key, async (post, init, protocol) => {
    const tools: IfindTool[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined,
      complete = false;
    for (let page = 0; page < 5; page++) {
      const result = await post("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools))
        throw new Error("iFinD 工具清单格式无效。");
      for (const item of result.tools) {
        if (
          !isRecord(item) ||
          typeof item.name !== "string" ||
          !item.name ||
          item.name.length > 256 ||
          !isRecord(item.inputSchema) ||
          item.inputSchema.type !== "object"
        )
          throw new Error("iFinD 返回的工具定义缺少名称或输入结构。");
        if (seen.has(item.name))
          throw new Error("iFinD 工具清单出现重复名称，未保存不完整结果。");
        seen.add(item.name);
        tools.push({
          name: item.name,
          title:
            typeof item.title === "string"
              ? item.title.slice(0, 200)
              : undefined,
          description:
            typeof item.description === "string"
              ? item.description.slice(0, 2000)
              : undefined,
          inputSchema: item.inputSchema,
          ...(isRecord(item.outputSchema)
            ? { outputSchema: item.outputSchema }
            : {}),
          ...(isRecord(item.annotations)
            ? { annotations: item.annotations }
            : {}),
        });
        if (tools.length > 500)
          throw new Error("iFinD 工具清单超过本版容量，未保存不完整结果。");
      }
      if (result.nextCursor == null) {
        complete = true;
        break;
      }
      if (
        typeof result.nextCursor !== "string" ||
        !result.nextCursor ||
        cursors.has(result.nextCursor)
      )
        throw new Error("iFinD 工具分页游标无效。");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    if (!complete)
      throw new Error("iFinD 工具分页超过本版上限，请缩小服务范围后重试。");
    const state: IfindConnection = {
      status: "connected",
      checkedAt: new Date().toISOString(),
      serverName:
        isRecord(init.serverInfo) && typeof init.serverInfo.name === "string"
          ? init.serverInfo.name.slice(0, 200)
          : "iFinD MCP",
      protocolVersion: protocol,
      tools,
      complete,
      researchEnabled: true,
    };
    const encoded = JSON.stringify(state).replaceAll(key, "[redacted]");
    if (new TextEncoder().encode(encoded).byteLength > 900000)
      throw new Error("iFinD 工具定义超过保存上限，连接清单未保存。");
    return JSON.parse(encoded) as IfindConnection;
  });
}

export async function callIfindTool(
  key: string,
  name: string,
  args: Record<string, unknown>,
  beforeCall?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  return withIfindSession(
    key,
    async (post) => {
      await beforeCall?.();
      const result = await post("tools/call", { name, arguments: args });
      if (result.isError === true)
        throw new Error(
          "iFinD 工具执行失败，请核对查询范围、参数和账户权限后重试。",
        );
      if (!Array.isArray(result.content) && !isRecord(result.structuredContent))
        throw new Error("iFinD 工具未返回可解析内容。");
      const safe = JSON.stringify(result).replaceAll(key, "[redacted]");
      if (new TextEncoder().encode(safe).byteLength > 160000)
        throw new Error(
          "iFinD 返回数据过多，请缩小查询范围后重试；未保存截断数据。",
        );
      return JSON.parse(safe);
    },
    65000,
  );
}
