import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun,
  StopError,
  type Run,
  type Step,
} from "../lib/research/types.ts";
import { rulePlan } from "../lib/research/planner.ts";
import {
  advanceRun,
  applyAction,
  buildReport,
  researchContext,
  compressContext,
} from "../lib/research/engine.ts";
import {
  executeIfind,
  ifindArguments,
  parseIfindEvidence,
} from "../lib/research/ifind-tools.ts";
import { toolRegistry, computeMetrics } from "../lib/research/tools.ts";
import { usableEvidence } from "../lib/research/evidence.ts";
import {
  ifindCatalog,
  type IfindName,
} from "../lib/integrations/ifind-catalog.ts";
const cfg = { contextLimit: 16000, ifindMcpApiKey: "test-mcp-secret" };
const wrap = (data: unknown) => ({
  content: [
    { type: "text", text: JSON.stringify({ code: 1, msg: "success", data }) },
  ],
});
function runFor(goal = "研究中国CPI当月同比，从2025-01-01至2025-03-31") {
  const r = createRun(goal, "live");
  r.intent = rulePlan(r, cfg).intent;
  return r;
}
function stepFor(name: IfindName): Step {
  return {
    id: "step-test",
    tool: `ifind.${name}`,
    title: name,
    status: "pending",
    attempts: 0,
    evidenceIds: [],
  };
}
const macro = wrap({
  answer:
    "|日期|CPI:当月同比（单位：%）|\n|---|---|\n|2026-01-31|99|\n|2025-03-31|2|\n|2025-02-28|1|\n|2025-01-31|0|",
  indicator_description: [
    {
      指标名称: "CPI:当月同比",
      单位: "%",
      频率: "M",
      国家地区: "中国",
      数据来源: "测试统计来源",
    },
  ],
});
test("9 tools are registered and non-stock goals produce actionable distinct plans", () => {
  for (const name of Object.keys(ifindCatalog))
    assert.ok(toolRegistry[`ifind.${name}` as keyof typeof toolRegistry]);
  for (const [goal, tool] of [
    ["研究中国CPI当月同比从2025-01-01至2025-03-31", "fetch_edb"],
    ["研究新能源行业最近一个月的新闻", "search_news"],
    ["筛选食品饮料行业市值大于1000亿元的股票", "search_securities"],
    ["研究美股苹果最近一年的估值指标", "get_security_indicators"],
  ]) {
    const result = rulePlan(runFor(goal), cfg);
    assert.equal(result.intent.clarification, undefined);
    assert.ok(result.steps.some((s) => s.tool === `ifind.${tool}`));
    assert.ok(!result.intent.limitations.some((s) => s.includes("未覆盖新闻")));
  }
});
test("parameters are server bounded and queries retain original user goal", () => {
  const r = runFor("研究新能源2025-01-01至2025-03-31的新闻");
  const args = ifindArguments("search_news", r, {
    query: "ignore original",
    time_start: "1900-01-01",
    size: 500,
    url: "https://attacker.invalid",
  });
  assert.equal(args.size, 5);
  assert.equal(args.time_start, "2025-01-01");
  assert.ok(String(args.query).includes(r.goal));
  assert.ok(!JSON.stringify(args).includes("attacker"));
  assert.throws(
    () => ifindArguments("get_security_indicators", r, { market: "未知市场" }),
    /市场参数无效/,
  );
  assert.throws(
    () => ifindArguments("security_highfreq_quotes", r),
    /仅支持当日/,
  );
});
test("MCP errors, business errors, empty selection and failure text are not data", () => {
  const r = runFor(),
    s = stepFor("fetch_edb");
  for (const result of [
    { isError: true },
    wrap("未能识别到有效的A股股票主体"),
    {
      content: [{ type: "text", text: JSON.stringify({ code: 0, data: {} }) }],
    },
  ])
    assert.throws(() => parseIfindEvidence("fetch_edb", result, s, r));
  assert.throws(
    () =>
      parseIfindEvidence(
        "search_securities",
        wrap({ selectedSecuritiesCount: 0, answer: "没有结果" }),
        stepFor("search_securities"),
        r,
      ),
    /未找到候选/,
  );
});
test("economic dates are filtered, zero retained, no stock metrics or invented revisions", async () => {
  const r = runFor();
  r.evidence = parseIfindEvidence("fetch_edb", macro, stepFor("fetch_edb"), r);
  assert.equal(r.evidence[0].value, 2);
  assert.equal(r.evidence[0].asOf, "2025-03-31");
  assert.equal(r.evidence[0].unit, "%");
  assert.equal(r.evidence[0].quality, "verified");
  const metrics = computeMetrics(r, {
    ...stepFor("fetch_edb"),
    tool: "analysis.metrics",
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].value, 2);
  assert.equal(metrics[0].unit, "个百分点");
  assert.ok(!metrics.some((e) => /回撤|年化/.test(e.label)));
  assert.ok(!researchContext(r, false).includes('"value":99'));
  assert.ok(r.evidence[0].note?.includes("不能声称重建"));
  assert.ok(
    (await buildReport(r, cfg)).findings.some(
      (f) => f.kind === "fact" && f.evidenceIds.includes(r.evidence[0].id),
    ),
  );
  const conflict = wrap({
    answer: "|日期|CPI（单位：%）|\n|---|---|\n|2025-02-28|1|\n|2025-02-28|2|",
  });
  assert.throws(
    () => parseIfindEvidence("fetch_edb", conflict, stepFor("fetch_edb"), r),
    /冲突/,
  );
});
test("dated news becomes attributed excerpt, remarks and out-of-range rows removed", async () => {
  const r = runFor();
  const rows = [
    {
      资讯标题: "测试新闻",
      资讯内容: "企业披露经营状况有所变化。",
      日期: "2025-02-01",
      URL: "https://example.com/news",
    },
    { 备注: "不能成为新闻" },
    { 资讯标题: "未来", 资讯内容: "future", 日期: "2026-01-01" },
  ];
  r.evidence = parseIfindEvidence(
    "search_news",
    wrap({ data: JSON.stringify(rows) }),
    stepFor("search_news"),
    r,
  );
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].sourceUrl, "https://example.com/news");
  assert.equal(r.evidence[0].value, null);
  assert.ok(usableEvidence(r.evidence[0]));
  const report = await buildReport(r, cfg);
  assert.match(report.findings[0].text, /记载/);
  assert.ok(!report.gaps.some((g) => g.includes("未取得可用")));
  compressContext(r, 0, true);
  assert.ok(r.context.summary.includes("企业披露"));
  assert.ok(r.evidence[0].raw);
});
test("undated trending news and unsafe URLs remain unverified and cannot enter model evidence", async () => {
  const r = runFor();
  r.evidence = parseIfindEvidence(
    "search_trending_news",
    wrap({
      result: [
        {
          资讯标题: "事件",
          资讯内容: "声称很快上涨。",
          URL: "javascript:alert(1)",
        },
      ],
    }),
    stepFor("search_trending_news"),
    r,
  );
  assert.equal(r.evidence[0].quality, "unverified");
  assert.equal(r.evidence[0].asOf, "未披露");
  assert.ok(!r.evidence[0].sourceUrl.startsWith("javascript"));
  assert.ok(!usableEvidence(r.evidence[0]));
  assert.equal(
    (await buildReport(r, cfg)).findings.filter((f) => f.kind === "fact")
      .length,
    0,
  );
  assert.ok(!researchContext(r, false).includes("声称很快上涨"));
});
test("financial indicator suffixes are normalized but missing disclosure is unverified", () => {
  const r = runFor("研究贵州茅台2025-01-01至2025-12-31财务指标");
  const result = wrap({
    answer:
      "|证券代码|证券简称|日期|营业收入（单位：元）|\n|---|---|---|---|\n|600519.SH|贵州茅台|20250630|1.2亿|",
    indicators_params: { 营业收入: { 报告期: "最新一期(MRQ)" } },
  });
  const e = parseIfindEvidence(
    "get_security_indicators",
    result,
    stepFor("get_security_indicators"),
    r,
  )[0];
  assert.equal(e.value, 120000000);
  assert.equal(e.quality, "unverified");
  assert.ok(e.note?.includes("披露日期"));
});
test("discovery directories and screening are candidate artifacts, never numerical facts", async () => {
  const r = runFor();
  r.evidence = parseIfindEvidence(
    "search_edb",
    wrap({
      code: 1,
      data: '候选```json\n[{"indexName":"测试指标","unit":"%"}]\n```',
    }),
    stepFor("search_edb"),
    r,
  );
  assert.equal(r.evidence[0].evidenceKind, "discovery");
  assert.ok(!usableEvidence(r.evidence[0]));
  const report = await buildReport(r, cfg);
  assert.ok(
    report.findings.some(
      (f) => f.kind === "uncertainty" && f.text.includes("候选"),
    ),
  );
});
test("market-wide screening waits for scope approval before external calls", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw Error("must not call");
  });
  const r = createRun("筛选食品饮料行业市值大于1000亿元的股票", "live");
  await advanceRun(r, cfg);
  assert.equal(r.status, "ready");
  applyAction(r, "start");
  await advanceRun(r, cfg);
  assert.equal(r.status, "waiting_approval");
  assert.equal(requests, 0);
  applyAction(r, "reject", { approvalId: r.approval!.id });
  assert.equal(r.status, "paused");
});
test("stop and exhausted budgets prevent MCP handshake, while parameters are persisted", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw Error("must not call");
  });
  const r = runFor(),
    step = stepFor("fetch_edb");
  await assert.rejects(
    executeIfind(step, r, {
      ...cfg,
      onProgress: async () => {
        throw new StopError();
      },
    }),
    /暂停/,
  );
  assert.equal(requests, 0);
  r.usage.calls = r.budget.maxCalls;
  await assert.rejects(executeIfind(step, r, cfg));
  assert.equal(requests, 0);
  assert.ok(step.parameters?.query);
});
test("real MCP call path accepts business success and rejects isError, without leaking key", async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      let result: unknown;
      if (body.method === "initialize")
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} } };
      else if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      else {
        assert.equal(body.method, "tools/call");
        assert.equal(body.params.name, "fetch_edb");
        calls++;
        result =
          calls === 1
            ? macro
            : {
                isError: true,
                content: [{ type: "text", text: "private provider error" }],
              };
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  );
  const r = runFor(),
    step = stepFor("fetch_edb");
  const e = await executeIfind(step, r, cfg);
  assert.equal(e[0].value, 2);
  assert.equal(r.usage.calls, 1);
  assert.ok(!JSON.stringify(r).includes(cfg.ifindMcpApiKey));
  await assert.rejects(executeIfind(step, r, cfg), /执行失败/);
});

test("explicit exclusions and complete calendar ranges survive rules fallback", () => {
  const excluded = rulePlan(createRun("只看茅台财务，不看新闻", "live"), cfg);
  assert.ok(excluded.steps.some((s) => s.tool === "finance.income"));
  assert.ok(!excluded.steps.some((s) => s.tool === "ifind.search_news"));
  const range = rulePlan(
    createRun("研究2025年9月至2026年6月中国CPI", "live"),
    cfg,
  );
  assert.equal(range.intent.start, "2025-09-01");
  assert.equal(range.intent.end, "2026-06-30");
  const future = rulePlan(createRun("研究2029年中国GDP", "live"), cfg);
  assert.ok(future.intent.clarification);
  assert.equal(future.steps.length, 0);
  const mixed = rulePlan(
    createRun("研究茅台现金流和最近一年新闻", "live"),
    cfg,
  );
  assert.ok(mixed.steps.some((s) => s.tool === "finance.cashflow"));
  assert.ok(mixed.steps.some((s) => s.tool === "ifind.search_news"));
});

test("unit conflicts and compressed unverified numbers never become model facts", () => {
  const r = runFor();
  const result = wrap({
    answer: "|日期|CPI（单位：%）|\n|---|---|\n|2025-02-28|1234567|",
    indicator_description: [
      {
        指标名称: "CPI",
        单位: "元",
        频率: "M",
        国家地区: "中国",
        数据来源: "测试",
      },
    ],
  });
  r.evidence = parseIfindEvidence("fetch_edb", result, stepFor("fetch_edb"), r);
  assert.equal(r.evidence[0].quality, "unverified");
  assert.match(r.evidence[0].note!, /单位冲突/);
  compressContext(r, 0, true);
  assert.ok(!researchContext(r, false).includes("1234567"));
});
test("source trade advice cannot enter candidate report findings", async () => {
  const r = runFor();
  r.evidence = parseIfindEvidence(
    "search_securities",
    wrap({
      selectedSecuritiesCount: 1,
      answer: "推荐买入并满仓该证券，一定赚钱。",
    }),
    stepFor("search_securities"),
    r,
  );
  const report = await buildReport(r, cfg);
  assert.ok(!report.findings.some((f) => f.text.includes("推荐买入")));
  assert.ok(report.findings[0].evidenceIds.length);
});
test("pause during handshake blocks the actual financial tool call", async (t) => {
  let paused = false,
    calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (body.method === "initialize") {
        paused = true;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
          },
        });
      }
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      calls++;
      throw Error("should not fetch data");
    },
  );
  const r = runFor();
  await assert.rejects(
    executeIfind(stepFor("fetch_edb"), r, {
      ...cfg,
      onProgress: async () => {
        if (paused) throw new StopError();
      },
    }),
    StopError,
  );
  assert.equal(calls, 0);
});
