import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun,
  StopError,
  type RuntimeConfig,
} from "../lib/research/types.ts";
import { plan } from "../lib/research/planner.ts";
import { advanceRun, applyAction } from "../lib/research/engine.ts";

const config: RuntimeConfig = {
  contextLimit: 16000,
  llmBaseUrl: "https://example.test/v1",
  llmApiKey: "test-only",
  llmModel: "test",
  ifindMcpApiKey: "test-only",
  fuyaoApiKey: "test-only",
};
const goal = "比较贵州茅台和五粮液最近三年的盈利质量与估值，重点关注现金流。";
function response(tasks: unknown[], focus = ["盈利质量", "估值", "现金流"]) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              securities: [
                { code: "600519.SH", name: "贵州茅台", kind: "stock" },
                { code: "000858.SZ", name: "五粮液", kind: "stock" },
              ],
              focus,
              start: "2023-10-08",
              end: "2026-10-08",
              years: 3,
              tasks,
            }),
          },
        },
      ],
    }),
  );
}

test("真实失败形状：现金流别名、嵌套code、同查询iFinD归一后仍由模型规划", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    response([
      {
        tool: "finance.cashflow",
        parameters: { code: "600519.SH", url: "https://invalid.test" },
      },
      { tool: "finance.cashflow", parameters: { code: "000858.SZ" } },
      {
        tool: "ifind.get_stock_summary",
        parameters: { market: "A股", code: "600519.SH" },
      },
      {
        tool: "ifind.get_stock_summary",
        parameters: { market: "A股", code: "000858.SZ" },
      },
    ]),
  );
  const result = await plan(createRun(goal, "live"), config);
  assert.equal(result.model, true, result.warning);
  assert.deepEqual(result.intent.focus, ["盈利质量", "估值"]);
  assert.deepEqual(
    result.steps
      .filter((s) => s.tool === "finance.cashflow")
      .map((s) => s.security?.code),
    ["600519.SH", "000858.SZ"],
  );
  assert.equal(
    result.steps.filter((s) => s.tool === "ifind.get_stock_summary").length,
    1,
  );
  assert.ok(!JSON.stringify(result).includes("invalid.test"));
});

test("等价参数兼容不能放过冲突code、越界标的或未注册能力", async (t) => {
  const cases = [
    {
      tasks: [
        {
          tool: "finance.cashflow",
          code: "600519.SH",
          parameters: { code: "000858.SZ" },
        },
      ],
    },
    {
      tasks: [{ tool: "finance.cashflow", parameters: { code: "300750.SZ" } }],
    },
    { tasks: [{ tool: "trade.buy", parameters: { code: "600519.SH" } }] },
    {
      tasks: [{ tool: "finance.cashflow", parameters: { code: "600519.SH" } }],
      focus: ["trade.buy"],
    },
    {
      tasks: [
        {
          tool: "ifind.get_security_indicators",
          parameters: { market: "A股" },
        },
        {
          tool: "ifind.get_security_indicators",
          parameters: { market: "港股" },
        },
      ],
    },
  ];
  for (const c of cases) {
    t.mock.method(globalThis, "fetch", async () => response(c.tasks, c.focus));
    const result = await plan(createRun(goal, "live"), config);
    assert.equal(result.model, false);
    assert.equal(result.blocked, true);
    assert.match(result.warning!, /未完成/);
    t.mock.restoreAll();
  }
});

test("最近三年以今天截止，明确历史范围不被改成当前日期", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const data = (await response([
      { tool: "finance.valuation", code: "600519.SH" },
    ]).json()) as { choices: { message: { content: string } }[] };
    const plan = JSON.parse(data.choices[0].message.content);
    plan.start = "2023-01-01";
    plan.end = "2025-12-31";
    data.choices[0].message.content = JSON.stringify(plan);
    return new Response(JSON.stringify(data));
  });
  const rolling = await plan(createRun(goal, "live"), config);
  assert.equal(rolling.model, true);
  assert.equal(
    rolling.intent.end,
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
  );
  const historical = await plan(
    createRun("比较茅台和五粮液2023-01-01至2025-12-31的盈利质量与估值", "live"),
    config,
  );
  assert.equal(historical.model, true);
  assert.equal(historical.intent.end, "2025-12-31");
});

test("显式重试保留预算与失败记录，新模型计划需重新确认", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("unauthorized", { status: 401 }),
  );
  const run = createRun(goal, "live");
  await advanceRun(run, config);
  assert.equal(run.planner, "failed");
  const tokens = run.usage.tokens;
  applyAction(run, "retry_plan");
  assert.equal(run.status, "planning");
  assert.equal(run.planner, "pending");
  assert.equal(run.usage.calls, 1);
  assert.equal(run.usage.tokens, tokens);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () =>
    response([{ tool: "finance.cashflow", code: "600519.SH" }]),
  );
  await advanceRun(run, config);
  assert.equal(run.status, "ready");
  assert.equal(run.planner, "model");
  assert.equal(run.usage.calls, 2);
  assert.ok(run.events.some((e) => e.type === "plan_failed"));
  assert.ok(run.events.some((e) => e.type === "plan_retry"));
  assert.equal(run.evidence.length, 0);
});

test("重试不能重置已有取数、规则选择或已耗尽预算", async () => {
  const run = createRun(goal, "live", [], { maxCalls: 1 });
  await advanceRun(run, { contextLimit: 16000 });
  run.steps[0].attempts = 1;
  assert.throws(() => applyAction(run, "retry_plan"), /尚未取数/);
  run.steps[0].attempts = 0;
  run.modelSelection = { source: "rules" };
  assert.throws(() => applyAction(run, "retry_plan"), /规则模式/);
  run.modelSelection = { source: "site" };
  run.usage.calls = 1;
  applyAction(run, "retry_plan");
  await advanceRun(run, config);
  assert.equal(run.planner, "failed");
  assert.equal(run.usage.calls, 1);
});

test("严格结构化输出约束工具和focus，语义错误最多自动修复一次", async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.response_format.type, "json_schema");
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(
        body.response_format.json_schema.schema.additionalProperties,
        false,
      );
      assert.ok(
        body.response_format.json_schema.schema.properties.tasks.items.properties.tool.enum.includes(
          "finance.cashflow",
        ),
      );
      if (++calls === 1)
        return response([{ tool: "trade.buy", code: "600519.SH" }]);
      assert.match(
        JSON.parse(body.messages[1].content).repair.reason,
        /未注册/,
      );
      return response([{ tool: "finance.cashflow", code: "600519.SH" }]);
    },
  );
  const run = createRun(goal, "live");
  run.modelSelection = { source: "site" };
  const result = await plan(run, {
    ...config,
    llmBaseUrl: "https://api.groq.com/openai/v1",
    llmModel: "openai/gpt-oss-120b",
  });
  assert.equal(result.model, true);
  assert.equal(run.usage.calls, 2);
  assert.equal(run.events.filter((e) => e.type === "plan_repair").length, 1);
  assert.ok(!run.events.some((e) => e.type === "model_fallback"));
});

test("截断响应明确识别并修复，不会把规则任务冒充模型任务", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? Response.json({
          choices: [
            { finish_reason: "length", message: { content: '{"tasks":' } },
          ],
        })
      : response([]),
  );
  const run = createRun(goal, "live");
  const result = await plan(run, config);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.steps, []);
  assert.equal(calls, 2);
  assert.match(
    run.events.find((e) => e.type === "plan_repair")!.detail!,
    /截断/,
  );
});

test("供应商JSON校验400可修复，普通参数400不盲目重试", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? Response.json(
          {
            error: {
              code: "json_validate_failed",
              message: "jsonschema: '/market' does not validate",
            },
          },
          { status: 400 },
        )
      : response([{ tool: "finance.cashflow", code: "600519.SH" }]),
  );
  const result = await plan(createRun(goal, "live"), config);
  assert.equal(result.model, true);
  assert.equal(calls, 2);
  t.mock.restoreAll();
  calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(
      { error: { code: "invalid_request_error" } },
      { status: 400 },
    );
  });
  assert.equal((await plan(createRun(goal, "live"), config)).blocked, true);
  assert.equal(calls, 1);
});

test("长时间429不盲目重试，保留等待时点且拒绝提前恢复", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("limited", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  });
  const run = createRun(goal, "live");
  await advanceRun(run, config);
  assert.equal(calls, 1);
  assert.equal(run.planner, "failed");
  assert.ok(Date.parse(run.modelRetryAt!) > Date.now() + 50000);
  assert.throws(() => applyAction(run, "retry_plan"), /等待窗口/);
  assert.throws(() => applyAction(run, "resume"), /等待窗口/);
  assert.equal(run.steps.length, 0);
});

test("缺模型配置和日额度不足不消耗请求、不自动切换规则", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return response([]);
  });
  for (const runtime of [
    { contextLimit: 16000 },
    {
      ...config,
      beforeModelCall: async () => {
        throw new Error("本次模型调用已达到工作台或站点的额度限制");
      },
    },
  ]) {
    const run = createRun(goal, "live");
    run.modelSelection = { source: "site" };
    await advanceRun(run, runtime);
    assert.equal(run.planner, "failed");
    assert.equal(run.usage.calls, 0);
  }
  assert.equal(requests, 0);
});

test("自动修复前用户暂停会阻止第二次调用", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response([], ["bad-focus"]);
  });
  const run = createRun(goal, "live");
  await advanceRun(run, {
    ...config,
    onProgress: async (r) => {
      if (r.events.some((e) => e.type === "plan_repair")) throw new StopError();
    },
  });
  assert.equal(run.status, "paused");
  assert.equal(calls, 1);
});
