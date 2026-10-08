import test from "node:test";
import assert from "node:assert/strict";
import { createRun, type RuntimeConfig } from "../lib/research/types.ts";
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
    assert.match(result.warning!, /失败/);
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
    async () => new Response("unavailable", { status: 503 }),
  );
  const run = createRun(goal, "live");
  await advanceRun(run, config);
  assert.equal(run.planner, "rules");
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
  assert.ok(run.events.some((e) => e.type === "model_fallback"));
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
  assert.equal(run.planner, "rules");
  assert.equal(run.usage.calls, 1);
});
