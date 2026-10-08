import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun,
  type Run,
  type Evidence,
  type RuntimeConfig,
  StopError,
} from "../lib/research/types.ts";
import { inferIntent, plan } from "../lib/research/planner.ts";
import {
  advanceRun,
  applyAction,
  compressContext,
  researchContext,
  buildReport,
  unsafeFinancialLanguage,
} from "../lib/research/engine.ts";
import { executeDataTool, computeMetrics } from "../lib/research/tools.ts";
const config: RuntimeConfig = { contextLimit: 5000 };
async function ready(
  goal: string,
  options: Parameters<typeof createRun>[3] = {},
) {
  const r = createRun(goal, "demo", [], options);
  await advanceRun(r, config);
  assert.equal(r.status, "ready");
  return r;
}
async function finish(r: Run) {
  if (["ready", "paused"].includes(r.status)) applyAction(r, "resume");
  for (let i = 0; i < 35 && r.status !== "completed"; i++) {
    if (r.approval) applyAction(r, "approve", { approvalId: r.approval.id });
    await advanceRun(r, config);
  }
  assert.equal(r.status, "completed");
  return r;
}
function mockResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function source(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev_fixture",
    stepId: "step_data",
    security: { code: "600519.SH", name: "贵州茅台", kind: "stock" },
    label: "区间末日收盘价",
    value: 9,
    unit: "元/股",
    asOf: "2025-01-03",
    retrievedAt: "2025-01-04T00:00:00Z",
    source: "synthetic-test",
    sourceUrl: "",
    field: "data.close",
    basis: "测试日线",
    quality: "demo",
    raw: { close: 9 },
    series: [
      { date: "2025-01-01", value: 10 },
      { date: "2025-01-02", value: 12 },
      { date: "2025-01-03", value: 9 },
    ],
    ...overrides,
  };
}
test("不同自由目标产生不同标的与工具任务", async () => {
  const a = await ready("研究茅台近一个月走势");
  const b = await ready("比较五粮液和比亚迪最近三年现金流与估值");
  assert.equal(a.intent!.focus[0], "价格与风险");
  assert.ok(a.steps.some((s) => s.tool === "market.history"));
  assert.ok(b.steps.some((s) => s.tool === "finance.cashflow"));
  assert.equal(b.intent!.securities.length, 2);
  assert.equal(b.intent!.years, 3);
  assert.ok(
    Date.parse(a.intent!.end) - Date.parse(a.intent!.start) < 33 * 86400000,
  );
});
test("完整代码去重且明确月份与日期范围", () => {
  const i = inferIntent("000001.SH和000001.SZ近三个月走势");
  assert.equal(i.securities.length, 2);
  assert.equal(i.securities[0].kind, "index");
  assert.equal(i.securities[1].kind, "stock");
  assert.ok(Date.parse(i.end) - Date.parse(i.start) < 96 * 86400000);
  assert.ok(inferIntent("茅台从2025-12-01到2025-02-30").clarification);
  assert.ok(inferIntent("研究沪深300盈利质量").clarification);
});
test("未知标的要求澄清，补充后可规划", async () => {
  const r = createRun("研究现金流质量", "demo");
  await advanceRun(r, config);
  assert.equal(r.status, "needs_input");
  applyAction(r, "clarify", { text: "贵州茅台600519" });
  await advanceRun(r, config);
  assert.equal(r.status, "ready");
});
test("记忆真实影响新计划，显式只看目标优先", async () => {
  const r = createRun("研究贵州茅台", "demo", [
    {
      id: "m1",
      text: "重点关注现金流并输出简短摘要",
      createdAt: new Date().toISOString(),
    },
  ]);
  await advanceRun(r, config);
  assert.ok(r.steps.some((s) => s.tool === "finance.cashflow"));
  assert.equal(r.intent!.output, "摘要");
  assert.deepEqual(inferIntent("只看贵州茅台走势", ["重点关注现金流"]).focus, [
    "价格与风险",
  ]);
});
test("三年财务主链路、引用和同口径计算", async () => {
  const r = await finish(
    await ready("比较贵州茅台和五粮液最近三年现金流与估值"),
  );
  assert.equal(r.usage.calls, 6);
  assert.equal(
    new Set(r.evidence.filter((e) => e.label === "营业收入").map((e) => e.asOf))
      .size,
    3,
  );
  assert.equal(r.evidence.filter((e) => e.label === "现金利润比").length, 6);
  assert.ok(
    r.report!.findings.every((f) =>
      f.evidenceIds.every((id) => r.evidence.some((e) => e.id === id)),
    ),
  );
  assert.ok(r.report!.gaps.some((g) => g.includes("构造")));
});
test("服务端预算门禁：未批准不调用、拒绝停止、过期审批失效", async () => {
  const r = await ready("贵州茅台现金流研究", { maxCalls: 1 });
  applyAction(r, "start");
  await advanceRun(r, config);
  await advanceRun(r, config);
  assert.equal(r.status, "waiting_approval");
  const id = r.approval!.id;
  for (let i = 0; i < 3; i++) await advanceRun(r, config);
  assert.equal(r.usage.calls, 1);
  assert.throws(() => applyAction(r, "approve", { approvalId: "wrong" }));
  applyAction(r, "reject", { approvalId: id });
  assert.equal(r.status, "paused");
  await advanceRun(r, config);
  assert.equal(r.usage.calls, 1);
  assert.throws(() => applyAction(r, "approve", { approvalId: id }));
});
test("扩大标的范围须审批；部分报告不会继续数据请求", async () => {
  const r = await ready("比较茅台、五粮液、比亚迪的走势");
  applyAction(r, "start");
  await advanceRun(r, config);
  assert.equal(r.approval?.kind, "scope");
  assert.equal(r.usage.calls, 0);
  applyAction(r, "partial");
  await finish(r);
  assert.equal(r.usage.calls, 0);
  assert.ok(r.report!.gaps.some((g) => g.includes("未取得可用")));
});
test("检查点序列化恢复不会重复已提交任务", async () => {
  let r = await ready("贵州茅台现金流研究");
  applyAction(r, "start");
  await advanceRun(r, config);
  const ids = r.evidence.map((e) => e.id);
  applyAction(r, "pause");
  r = JSON.parse(JSON.stringify(r));
  await finish(r);
  assert.equal(r.usage.calls, 2);
  assert.ok(ids.every((id) => r.evidence.some((e) => e.id === id)));
  assert.equal(r.steps[0].attempts, 1);
});
test("工具失败保留缺口，单任务重试复用其余结果", async () => {
  const r = await finish(
    await ready("茅台现金流研究", { fault: "tool_failure" }),
  );
  assert.equal(r.steps[0].status, "failed");
  assert.ok(r.report!.gaps.some((g) => g.includes("模拟一次工具超时")));
  const calls = r.usage.calls;
  const retained = r.evidence.find((e) => e.label === "经营现金流净额")!.id;
  applyAction(r, "retry", { stepId: r.steps[0].id });
  await finish(r);
  assert.equal(r.usage.calls, calls + 1);
  assert.ok(r.evidence.some((e) => e.id === retained));
  assert.equal(r.steps[0].attempts, 2);
});
test("缺失字段演练覆盖行情与财报，不生成替代值", async () => {
  for (const goal of ["茅台走势研究", "茅台现金流研究"]) {
    const r = await finish(await ready(goal, { fault: "missing_data" }));
    assert.ok(r.faultUsed);
    assert.ok(
      r.evidence.some((e) => e.value === null && e.quality === "missing"),
    );
    assert.ok(r.report!.gaps.some((g) => g.includes("缺失")));
    if (goal.includes("走势"))
      assert.equal(r.evidence.filter((e) => e.formula).length, 0);
  }
});
test("计算最大回撤、区间收益和样本波动可复算", () => {
  const r = createRun("价格测试", "demo");
  r.evidence = [source()];
  const values = computeMetrics(r, {
    id: "calc",
    title: "compute",
    tool: "analysis.metrics",
    status: "running",
    attempts: 1,
    evidenceIds: [],
  });
  assert.equal(values.find((e) => e.label === "区间涨跌幅")!.value, -10);
  assert.equal(values.find((e) => e.label === "最大回撤")!.value, -25);
  assert.ok(values.every((e) => e.inputIds?.[0] === "ev_fixture"));
});
test("压缩后实际上下文变短，引用、口径与原始数据保留", async () => {
  const r = await ready("研究茅台近一年走势");
  applyAction(r, "start");
  await advanceRun(r, { contextLimit: 999999 });
  const raw = JSON.stringify(r.evidence);
  const before = researchContext(r);
  assert.ok(compressContext(r, 100));
  assert.ok(researchContext(r).length < before.length);
  assert.ok(r.context.summary.includes(r.evidence[0].id));
  assert.ok(r.context.summary.includes(r.evidence[0].basis));
  assert.equal(JSON.stringify(r.evidence), raw);
});
test("达到时限后不再调用", async () => {
  const r = await ready("茅台走势研究");
  applyAction(r, "start");
  r.usage.durationMs = r.budget.maxMs;
  await advanceRun(r, config);
  assert.equal(r.status, "paused");
  assert.equal(r.usage.calls, 0);
});
test("指数不能通过演示模式生成公司财报", async () => {
  const r = createRun("指数", "demo");
  r.intent = inferIntent("沪深300走势");
  await assert.rejects(
    executeDataTool(
      {
        id: "x",
        title: "x",
        tool: "finance.income",
        security: r.intent.securities[0],
        status: "running",
        attempts: 1,
        evidenceIds: [],
      },
      r,
      config,
    ),
    /不支持指数财报/,
  );
});
test("扶摇 HTTP200 业务错误仍失败，不伪造证据", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({ code: 2003, message: "Missing X-api-key", data: null }),
  );
  const r = createRun("茅台现金流研究", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, { ...config, fuyaoApiKey: "test-only" });
  assert.equal(r.steps[0].status, "failed");
  assert.match(r.steps[0].error!, /2003/);
  assert.equal(r.evidence.length, 0);
});
test("扶摇正确字段、上海日期与过期标记", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        item: [
          { date_ms: Date.parse("2025-01-02T00:00:00+08:00"), close_price: 10 },
          { date_ms: Date.parse("2025-01-03T00:00:00+08:00"), close_price: 9 },
        ],
      },
    }),
  );
  const r = createRun("茅台2025-01-01至2025-06-01走势", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, { ...config, fuyaoApiKey: "test-only" });
  assert.equal(r.evidence[0].asOf, "2025-01-03");
  assert.equal(r.evidence[0].quality, "stale");
  assert.equal(r.evidence[0].value, 9);
});
test("真实财报按披露日过滤，合并利润口径可追溯", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        item: [
          {
            period_end_ms: Date.parse("2024-12-31"),
            report_date_ms: Date.parse("2025-03-20"),
            net_profit: 100,
            operating_income: 500,
          },
          {
            period_end_ms: Date.parse("2023-12-31"),
            report_date_ms: Date.parse("2024-03-20"),
            net_profit: 80,
            operating_income: 400,
          },
        ],
      },
    }),
  );
  const r = createRun("茅台截至2025-02-01现金流研究", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, { ...config, fuyaoApiKey: "test-only" });
  assert.ok(r.evidence.every((e) => e.asOf === "2023-12-31"));
  const profit = r.evidence.find((e) => e.label === "合并净利润")!;
  assert.equal(profit.value, 80);
  const original = profit.raw as { data: { item: Record<string, unknown>[] } };
  assert.equal(original.data.item[0].net_profit, 80);
});
test("缺失时点不作为已验证事实或模型引用", async (t) => {
  const r = await ready("茅台走势");
  r.evidence = [source({ quality: "missing", asOf: "未披露" })];
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      usage: { total_tokens: 100 },
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: [
                { text: "已取得完整证据。", evidenceIds: ["ev_fixture"] },
              ],
            }),
          },
        },
      ],
    }),
  );
  const report = await buildReport(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.equal(
    report.findings.filter((f) => f.kind !== "uncertainty").length,
    0,
  );
});
test("模型输出非法日期、未注册能力时修复失败后停止规划", async (t) => {
  for (const overrides of [{ start: "2010-02-30" }, { focus: ["trade.buy"] }]) {
    t.mock.method(globalThis, "fetch", async () =>
      mockResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                securities: [
                  { code: "600519.SH", name: "茅台", kind: "stock" },
                ],
                focus: ["价格与风险"],
                start: "2025-01-01",
                end: "2025-02-01",
                ...overrides,
              }),
            },
          },
        ],
      }),
    );
    const r = createRun("研究茅台近一个月走势", "demo");
    const result = await plan(r, {
      ...config,
      llmApiKey: "test-only",
      llmBaseUrl: "https://example.test/v1",
      llmModel: "test",
    });
    assert.equal(result.model, false);
    assert.equal(result.blocked, true);
    assert.equal(result.steps.length, 0);
    assert.match(result.warning!, /未完成/);
    t.mock.restoreAll();
  }
});
test("模型不能将已知指数伪装成公司", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              securities: [{ code: "000300.SH", name: "任意", kind: "stock" }],
              focus: ["盈利质量"],
              start: "2025-01-01",
              end: "2025-02-01",
            }),
          },
        },
      ],
    }),
  );
  const r = createRun("沪深300财务研究", "demo");
  const result = await plan(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.equal(result.intent.securities[0].kind, "index");
  assert.ok(result.intent.clarification);
  assert.equal(result.steps.length, 0);
});
test("模型违规买卖建议与确定预测被排除", async (t) => {
  const r = await ready("茅台走势");
  r.evidence = [source()];
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: [
                {
                  text: "建议加仓并重仓持有，股价一定上涨。",
                  evidenceIds: ["ev_fixture"],
                },
              ],
            }),
          },
        },
      ],
    }),
  );
  const report = await buildReport(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.ok(report.findings.every((f) => !unsafeFinancialLanguage(f.text)));
  assert.equal(report.findings.filter((f) => f.kind === "inference").length, 0);
});
test("停止检查在外部请求前生效，不消费调用预算", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return mockResponse({});
  });
  const r = createRun("茅台走势研究", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, {
    ...config,
    onProgress: async () => {
      throw new StopError();
    },
  });
  assert.equal(r.status, "paused");
  assert.equal(calls, 0);
  assert.equal(r.usage.calls, 0);
  assert.equal(r.steps[0].status, "pending");
});
test("上海截止日不会纳入次日披露的财报", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        item: [
          {
            period_end_ms: Date.parse("2025-12-31T00:00:00+08:00"),
            report_date_ms: Date.parse("2026-01-02T00:00:00+08:00"),
            net_profit: 100,
            operating_income: 500,
          },
          {
            period_end_ms: Date.parse("2024-12-31T00:00:00+08:00"),
            report_date_ms: Date.parse("2025-03-20T00:00:00+08:00"),
            net_profit: 80,
            operating_income: 400,
          },
        ],
      },
    }),
  );
  const r = createRun("茅台截至2026-01-01现金流研究", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, { ...config, fuyaoApiKey: "test-only" });
  assert.ok(r.evidence.every((e) => e.asOf === "2024-12-31"));
  const profit = r.evidence.find((e) => e.label === "合并净利润")!;
  assert.equal(profit.value, 80);
  const original = profit.raw as { data: { item: Record<string, unknown>[] } };
  assert.equal(original.data.item[0].net_profit, 80);
});
test("模型服务持续异常时保留已尝试预算，等待用户重试", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("error", { status: 503 }),
  );
  const r = createRun("茅台近一个月走势", "demo");
  await advanceRun(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.equal(r.status, "failed");
  assert.equal(r.planner, "failed");
  assert.equal(r.usage.calls, 2);
  assert.ok(r.usage.tokens > 0);
  assert.ok(r.events.some((e) => e.type === "plan_failed"));
});
test("历史行情只用区间内价格，忽略返回的最新快照", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        sh600519: {
          qfqday: [
            ["2025-01-02", "10", "10", "11", "9", "100"],
            ["2025-01-03", "10", "9", "11", "9", "100"],
            ["2026-01-05", "90", "99", "100", "90", "100"],
          ],
          qt: { sh600519: ["", "贵州茅台", "600519", "999"] },
        },
      },
    }),
  );
  const r = createRun("茅台2025-01-01至2025-01-03走势", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, config);
  assert.equal(r.evidence[0].value, 9);
  assert.equal(r.evidence[0].asOf, "2025-01-03");
  assert.equal(r.evidence[0].series!.length, 2);
});
test("模型可按自由目标选择不同注册工具组合", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              securities: [{ code: "600519.SH", name: "茅台", kind: "stock" }],
              focus: ["价格与风险"],
              start: "2025-01-01",
              end: "2025-02-01",
              tasks: [{ tool: "market.history", code: "600519.SH" }],
            }),
          },
        },
      ],
    }),
  );
  const r = createRun("只研究茅台历史收盘价", "demo");
  const result = await plan(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.equal(result.model, true);
  assert.deepEqual(
    result.steps.map((s) => s.tool),
    ["market.history", "analysis.metrics", "research.report"],
  );
});
test("模型不能让工具访问计划范围外的证券", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              securities: [{ code: "600519.SH", name: "茅台", kind: "stock" }],
              focus: ["价格与风险"],
              start: "2025-01-01",
              end: "2025-02-01",
              tasks: [{ tool: "market.history", code: "000858.SZ" }],
            }),
          },
        },
      ],
    }),
  );
  const r = createRun("只研究茅台历史收盘价", "demo");
  const result = await plan(r, {
    ...config,
    llmApiKey: "test-only",
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test",
  });
  assert.equal(result.model, false);
  assert.match(result.warning!, /超出研究标的/);
});
test("同一日期冲突价格不能生成正常结论", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        sh600519: {
          qfqday: [
            ["2025-01-02", "10", "10"],
            ["2025-01-02", "10", "99"],
          ],
        },
      },
    }),
  );
  const r = createRun("茅台2025-01-01至2025-01-03走势", "live");
  await advanceRun(r, config);
  applyAction(r, "start");
  await advanceRun(r, config);
  assert.equal(r.steps[0].status, "failed");
  assert.match(r.steps[0].error!, /冲突/);
  assert.equal(r.evidence.length, 0);
});

test("扶摇指数快照使用点位单位且原始响应匹配引用路径", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      code: 0,
      data: {
        timestamp: Date.now(),
        item: [{ thscode: "000300.SH", last_price: 4200 }],
      },
    }),
  );
  const run = createRun("沪深300近一月走势", "live");
  await advanceRun(run, config);
  const evidence = await executeDataTool(
    { ...run.steps[0], tool: "market.snapshot" },
    run,
    { ...config, fuyaoApiKey: "test-only" },
  );
  assert.equal(evidence[0].unit, "点");
  assert.equal(
    (evidence[0].raw as { data: { item: { last_price: number }[] } }).data
      .item[0].last_price,
    evidence[0].value,
  );
});
