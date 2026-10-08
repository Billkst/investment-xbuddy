import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverIfind,
  readRpcResponse,
  IFIND_ENDPOINT,
} from "../lib/integrations/ifind.ts";
const key = "ifind-test-secret-only";
const definition = {
  name: "quotes",
  inputSchema: {
    type: "object",
    properties: { symbols: { type: "array", items: { type: "string" } } },
    required: ["symbols"],
  },
};
function response(id: string, result: unknown, headers = {}) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers });
}
test("handshake, raw authentication, session, pagination, schema and cleanup", async (t) => {
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, IFIND_ENDPOINT);
      assert.equal(options.redirect, "manual");
      const headers = new Headers(options.headers);
      assert.equal(headers.get("Authorization"), key);
      if (options.method === "DELETE") {
        methods.push("DELETE");
        assert.equal(headers.get("Mcp-Session-Id"), "session-test");
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(options.body as string);
      methods.push(body.method);
      if (body.method === "initialize")
        return response(
          body.id,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test" },
          },
          { "Mcp-Session-Id": "session-test" },
        );
      assert.equal(headers.get("Mcp-Session-Id"), "session-test");
      assert.equal(headers.get("MCP-Protocol-Version"), "2025-06-18");
      if (body.method === "notifications/initialized") {
        assert.equal(body.id, undefined);
        return new Response(null, { status: 202 });
      }
      assert.equal(body.method, "tools/list");
      return response(
        body.id,
        body.params.cursor
          ? {
              tools: [
                {
                  name: "news",
                  inputSchema: { type: "object" },
                  description: key,
                },
              ],
            }
          : { tools: [definition], nextCursor: "page2" },
      );
    },
  );
  const result = await discoverIfind(key);
  assert.equal(result.status, "connected");
  assert.equal(result.tools.length, 2);
  assert.equal(result.researchEnabled, false);
  assert.deepEqual(result.tools[0].inputSchema, definition.inputSchema);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/list",
    "DELETE",
  ]);
});
test("SSE handles split UTF8/CRLF, notifications, unrelated ids and multi-line data", async () => {
  const data =
    ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0","id":"other","result":{}}\r\n\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":"wanted","result":{"text":"行情"}}\r\n\r\n';
  const bytes = new TextEncoder().encode(data);
  const stream = new ReadableStream({
    start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    },
  });
  assert.deepEqual(
    await readRpcResponse(
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
      "wanted",
    ),
    { text: "行情" },
  );
});
test("HTTP auth, redirect and protocol errors never expose upstream messages", async (t) => {
  for (const status of [401, 302]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(key, { status }),
    );
    await assert.rejects(
      discoverIfind(key),
      (e) => e instanceof Error && !e.message.includes(key),
    );
    t.mock.restoreAll();
  }
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32001, message: key },
      });
    },
  );
  await assert.rejects(discoverIfind(key), /协议错误码 -32001/);
});
test("initialization notification errors cannot produce connected status", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      return body.method === "initialize"
        ? response(body.id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
          })
        : Response.json({ jsonrpc: "2.0", error: { code: -32601 } });
    },
  );
  await assert.rejects(discoverIfind(key), /协议错误码 -32601/);
});
test("repeated pagination and malformed schemas fail without partial success", async (t) => {
  for (const invalid of [
    { tools: [{ name: "bad", inputSchema: {} }] },
    { tools: [], nextCursor: "loop" },
  ]) {
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        if (body.method === "initialize")
          return response(body.id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
          });
        if (body.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        return response(body.id, invalid);
      },
    );
    await assert.rejects(discoverIfind(key), /输入结构|游标无效/);
    t.mock.restoreAll();
  }
});
test("unmatched and oversized responses are rejected", async () => {
  await assert.rejects(
    readRpcResponse(response("other", {}), "wanted"),
    /匹配/,
  );
  await assert.rejects(
    readRpcResponse(new Response("x".repeat(2_000_001)), "wanted"),
    /响应过大/,
  );
});

test("iFinD observed HTTP200 notification acknowledgement is accepted", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (body.method === "initialize")
        return response(body.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        });
      if (body.method === "notifications/initialized")
        return response("server-generated-id", { _notification_handled: true });
      return response(body.id, { tools: [definition] });
    },
  );
  assert.equal((await discoverIfind(key)).status, "connected");
});
