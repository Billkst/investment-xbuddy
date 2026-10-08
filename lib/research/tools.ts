import { ifindCatalog } from "../integrations/ifind-catalog.ts";
import { executeIfind } from "./ifind-tools.ts";
import { numericEvidence } from "./evidence.ts";
import {
  type Evidence,
  type Run,
  type Step,
  type RuntimeConfig,
  type Security,
  type ToolName,
  now,
  uid,
  consumeRequest,
  event,
  BudgetError,
  StopError,
} from "./types.ts";
export const toolRegistry: Record<
  ToolName,
  {
    title: string;
    description: string;
    permission: string;
    timeoutMs: number;
    cost: string;
    parameters: Record<string, unknown>;
  }
> = {
  ...(Object.fromEntries(
    Object.entries(ifindCatalog).map(([name, tool]) => [
      `ifind.${name}`,
      {
        title: tool.title,
        description: tool.description,
        permission: "ifind:read",
        timeoutMs: 65000,
        cost: "1次MCP取数请求；需iFinD权限",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, market: { type: "string" } },
        },
      },
    ]),
  ) as unknown as Record<
    `ifind.${keyof typeof ifindCatalog}`,
    {
      title: string;
      description: string;
      permission: string;
      timeoutMs: number;
      cost: string;
      parameters: Record<string, unknown>;
    }
  >),
  "market.snapshot": {
    title: "行情快照",
    description: "证券最新公开价格与数据时点",
    permission: "market:read",
    timeoutMs: 12000,
    cost: "1次数据请求",
    parameters: {
      type: "object",
      required: ["security"],
      properties: {
        security: { type: "string", pattern: "^\\d{6}\\.(SH|SZ|BJ)$" },
      },
    },
  },
  "market.history": {
    title: "历史日线",
    description: "指定区间的前复权收盘价；用于计算波动与回撤",
    permission: "market:read",
    timeoutMs: 12000,
    cost: "1次数据请求",
    parameters: {
      type: "object",
      required: ["security", "start", "end"],
      properties: {
        security: { type: "string" },
        start: { type: "string", format: "date" },
        end: { type: "string", format: "date" },
      },
    },
  },
  "finance.income": {
    title: "年度利润表",
    description: "营业收入、合并净利润与报告期",
    permission: "financials:read",
    timeoutMs: 12000,
    cost: "1次数据请求；需扶摇权限",
    parameters: {
      type: "object",
      required: ["security"],
      properties: { security: { type: "string" } },
    },
  },
  "finance.cashflow": {
    title: "年度现金流",
    description: "经营活动现金流量净额；年度合并口径",
    permission: "financials:read",
    timeoutMs: 12000,
    cost: "1次数据请求；需扶摇权限",
    parameters: {
      type: "object",
      required: ["security"],
      properties: { security: { type: "string" } },
    },
  },
  "finance.valuation": {
    title: "估值快照",
    description: "最新市盈率TTM、市净率MRQ；不支持历史估值",
    permission: "financials:read",
    timeoutMs: 12000,
    cost: "1次数据请求；需扶摇权限",
    parameters: {
      type: "object",
      required: ["security"],
      properties: { security: { type: "string" } },
    },
  },
  "analysis.metrics": {
    title: "指标计算",
    description: "用证据计算区间涨跌幅、最大回撤与现金利润比，保存公式",
    permission: "compute",
    timeoutMs: 1000,
    cost: "无外部调用",
    parameters: { type: "object" },
  },
  "research.report": {
    title: "研究报告",
    description: "整理事实、推断、缺失项与可追溯引用",
    permission: "artifact:write",
    timeoutMs: 25000,
    cost: "可选1次模型调用",
    parameters: { type: "object" },
  },
};
const asDate = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))
    return value.slice(0, 10);
  return "未披露";
};
function assertNoConflicts(
  rows: Record<string, unknown>[],
  key: string,
  fields: string[],
) {
  const seen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = String(row[key]);
    const previous = seen.get(id);
    if (previous && fields.some((field) => previous[field] !== row[field]))
      throw new Error("上游返回同一时点的冲突记录，已停止生成该项结论");
    seen.set(id, row);
  }
}
const numeric = (x: unknown): number | null =>
  x === null || x === undefined || x === "" || !Number.isFinite(Number(x))
    ? null
    : Number(x);
function base(
  step: Step,
  run: Run,
  config: {
    label: string;
    value: number | null;
    unit: string;
    asOf: string;
    source: string;
    sourceUrl: string;
    field: string;
    basis: string;
    raw: unknown;
    series?: Evidence["series"];
    note?: string;
  },
): Evidence {
  return {
    id: uid("ev"),
    stepId: step.id,
    security: step.security!,
    retrievedAt: now(),
    quality:
      config.value === null
        ? "missing"
        : run.mode === "demo"
          ? "demo"
          : "verified",
    ...config,
  };
}
async function requestJson(
  url: string,
  run: Run,
  headers: Record<string, string> = {},
  config?: RuntimeConfig,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await config?.onProgress?.(run);
    consumeRequest(run);
    await config?.onProgress?.(run);
    const start = Date.now();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new Error(`AUTH: 数据服务拒绝访问（HTTP ${response.status}）`);
        throw new Error(`数据服务返回 HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("数据响应超出大小限制");
      const data = JSON.parse(text);
      if (!data || typeof data !== "object")
        throw new Error("数据服务返回格式无效");
      event(
        run,
        "request",
        "数据请求完成",
        new URL(url).hostname,
        Date.now() - start,
      );
      return data;
    } catch (e) {
      if (e instanceof BudgetError || e instanceof StopError) throw e;
      const cause =
        e instanceof Error
          ? (e as Error & { cause?: { code?: unknown } }).cause?.code
          : undefined;
      const code =
        typeof cause === "string" && /^[A-Z0-9_]{2,50}$/.test(cause)
          ? cause
          : "";
      const message =
        e instanceof Error && e.message === "fetch failed"
          ? `数据源网络连接失败${code ? `（${code}）` : ""}，请稍后重试。`
          : e instanceof Error
            ? e.message
            : "网络错误";
      event(run, "request_error", `第 ${attempt + 1} 次数据请求失败`, message);
      if (attempt === 1 || message.startsWith("AUTH:"))
        throw new Error(message);
    }
  }
  throw new Error("数据服务不可用");
}
// Only registered endpoints are used. Model/user text can never supply an arbitrary fetch URL.
export async function executeDataTool(
  step: Step,
  run: Run,
  config: RuntimeConfig,
): Promise<Evidence[]> {
  if (step.tool.startsWith("ifind.")) return executeIfind(step, run, config);
  if (
    !Object.hasOwn(toolRegistry, step.tool) ||
    !step.security ||
    !/^\d{6}\.(SH|SZ|BJ)$/.test(step.security.code)
  )
    throw new Error("工具参数不合法或工具未注册");
  if (step.security.kind === "index" && step.tool.startsWith("finance."))
    throw new Error("当前财报/估值工具仅支持 A 股公司，不支持指数财报。");
  if (run.fault === "tool_failure" && !run.faultUsed) {
    run.faultUsed = true;
    throw new Error("故障演练：已模拟一次工具超时。可重试该任务。");
  }
  let result: Evidence[];
  if (run.mode === "demo") {
    consumeRequest(run);
    result = demoData(step, run);
  } else if (config.fuyaoApiKey)
    result = await fuyaoData(step, run, config.fuyaoApiKey, config);
  else if (step.tool === "market.history" || step.tool === "market.snapshot")
    result = await publicMarketData(step, run, config);
  else
    throw new Error(
      "未配置扶摇金融数据权限，无法取得真实财报或估值；该项标记为数据缺失，不会使用构造数值替代。",
    );
  if (run.fault === "missing_data" && !run.faultUsed && result.length) {
    run.faultUsed = true;
    const e = result[0];
    e.value = null;
    e.series = undefined;
    e.quality = "missing";
    e.raw = { fault: "missing_data", originalField: e.field, value: null };
    e.note = "故障演练：原始字段缺失（null），不补造数值或计算衍生指标。";
  }
  for (const e of result) {
    if (e.asOf === "未披露") {
      e.quality = "missing";
      e.note = (e.note ?? "") + " 数据时点未披露，不能作为已核验事实使用。";
    }
    if (
      run.mode === "live" &&
      ["market.snapshot", "finance.valuation"].includes(step.tool) &&
      e.asOf !== "未披露" &&
      Date.parse(run.intent!.end) - Date.parse(e.asOf) > 10 * 86400000
    ) {
      e.quality = "stale";
      e.note =
        (e.note ?? "") +
        " 快照时点距截止日超过10天，不可视为当前估值或实时行情。";
    }
    if (e.series?.length === 1)
      event(run, "data_gap", "有效交易日不足两个，无法计算区间风险指标");
    if (e.series?.length && run.mode === "live") {
      if (Date.parse(run.intent!.end) - Date.parse(e.asOf) > 10 * 86400000) {
        e.quality = "stale";
        e.note =
          (e.note ?? "") +
          " 数据末日距截止日超过10天，可能存在停牌、节假日或数据滞后。";
      }
      if (
        Date.parse(e.series[0].date) - Date.parse(run.intent!.start) >
        10 * 86400000
      ) {
        e.quality = "stale";
        e.note =
          (e.note ?? "") +
          " 返回数据未覆盖请求区间起点，指标仅描述实际返回区间。";
      }
    }
  }
  return result;
}
async function publicMarketData(
  step: Step,
  run: Run,
  config: RuntimeConfig,
): Promise<Evidence[]> {
  const s = step.security!;
  if (s.code.endsWith(".BJ"))
    throw new Error("当前公开行情备用源不支持北交所代码，请配置扶摇。");
  const symbol = s.code.split(".")[1].toLowerCase() + s.code.slice(0, 6);
  const intent = run.intent!;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${intent.start},${intent.end},2000,qfq`;
  const data = await requestJson(url, run, {}, config);
  if (data.code !== 0) throw new Error("公开行情服务业务状态异常");
  const payload = (
    data.data as Record<string, Record<string, unknown>> | undefined
  )?.[symbol];
  if (!payload) throw new Error("公开行情返回空结果，请检查证券代码");
  const qt = (payload.qt as Record<string, unknown[]> | undefined)?.[symbol];
  if (qt?.[1]) s.name = String(qt[1]);
  if (step.tool === "market.snapshot") {
    if (
      intent.end !==
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    )
      throw new Error("行情快照仅支持当前时点，不可替代历史截止日价格。");
    if (!qt || numeric(qt[3]) === null) throw new Error("行情快照价格字段缺失");
    const stamp = String(qt[30] ?? "");
    const asOf = /^\d{14}$/.test(stamp)
      ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)} +08:00`
      : "未披露";
    return [
      base(step, run, {
        label: "最新价",
        value: numeric(qt[3]),
        unit: s.kind === "index" ? "点" : "元/股",
        asOf,
        source: "腾讯财经公开行情（备用）",
        sourceUrl: url,
        field: `data.${symbol}.qt.${symbol}[3]`,
        basis: "未经复权的最新公开行情；上游时间为上海时区，不保证实时性",
        raw: { data: { [symbol]: { qt: { [symbol]: qt } } } },
      }),
    ];
  }
  const rows = (payload.qfqday ?? payload.day) as unknown[][] | undefined;
  assertNoConflicts(
    (Array.isArray(rows) ? rows : []).map((row) => ({
      date: row[0],
      close: row[2],
    })),
    "date",
    ["close"],
  );
  const series = (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        Array.isArray(row) &&
        typeof row[0] === "string" &&
        row[0] >= intent.start &&
        row[0] <= intent.end &&
        numeric(row[2]) !== null &&
        Number(row[2]) > 0,
    )
    .map((row) => ({ date: String(row[0]), value: Number(row[2]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!series.length)
    throw new Error(
      "所选区间无可用历史行情；非交易日或接口缺失均不会补造价格。",
    );
  const item = base(step, run, {
    label: "区间末日收盘价",
    value: series.at(-1)!.value,
    unit: s.kind === "index" ? "点" : "元/股",
    asOf: series.at(-1)!.date,
    source: "腾讯财经公开行情（备用）",
    sourceUrl: url,
    field: `data.${symbol}.${payload.qfqday ? "qfqday" : "day"}[date=${series.at(-1)!.date}][2]`,
    basis:
      s.kind === "index"
        ? "日线收盘点位；仅交易日"
        : (payload.qfqday ? "前复权" : "未复权") +
          "日线收盘价；仅交易日；非当前实时价",
    raw: {
      code: data.code,
      data: { [symbol]: { [payload.qfqday ? "qfqday" : "day"]: rows } },
      quoteTime: qt?.[30] ?? null,
    },
    series,
    note: "公开网页接口，无稳定服务承诺；最多请求 2000 根日线；前复权价格按当前口径重述，不能视为严格的历史可知价格。历史价格时点与最新行情时点可能不同。",
  });
  if (
    series[0].date >
    new Date(
      Date.parse(intent.start + "T00:00:00+08:00") + 8 * 86400000,
    ).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
  ) {
    item.note += " 本次结果未覆盖请求区间起点，指标仅针对实际返回区间。";
    event(
      run,
      "data_gap",
      "历史价格未覆盖完整请求区间",
      `${series[0].date} — ${series.at(-1)!.date}`,
    );
  }
  if (Date.parse(intent.end) - Date.parse(item.asOf) > 10 * 86400000) {
    item.quality = "stale";
    item.note +=
      " 数据末日距研究截止日超过 10 天，请检查停牌、长假或数据滞后。";
  }

  return [item];
}
async function fuyaoData(
  step: Step,
  run: Run,
  key: string,
  config: RuntimeConfig,
): Promise<Evidence[]> {
  const s = step.security!,
    intent = run.intent!;
  const origin = "https://fuyao.aicubes.cn";
  let path = "";
  const p = new URLSearchParams();
  if (step.tool === "market.history") {
    path = "/api/a-share/prices/historical";
    p.set("thscode", s.code);
    p.set("interval", "1d");
    if (s.kind !== "index") p.set("adjust", "forward");
    p.set("start", String(Date.parse(intent.start + "T00:00:00+08:00")));
    p.set("end", String(Date.parse(intent.end + "T23:59:59.999+08:00")));
  } else if (step.tool === "market.snapshot") {
    if (
      intent.end !==
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    )
      throw new Error("行情快照不支持历史截止日研究。");
    path = "/api/a-share/prices/snapshot";
    p.set("thscodes", s.code);
  } else if (step.tool === "finance.valuation") {
    if (
      intent.end <
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    )
      throw new Error("估值接口仅提供最新快照，无法用于历史截止日研究。");
    path = "/api/a-share/valuations/snapshot";
    p.set("thscodes", s.code);
  } else {
    path = `/api/a-share/financials/${step.tool === "finance.income" ? "income-statements" : "cash-flow-statements"}`;
    p.set("thscode", s.code);
    p.set("period", "annual");
    p.set("limit", "5");
  }
  if (s.kind === "index") path = path.replace("/a-share/", "/a-share-index/");
  const url = origin + path + "?" + p;
  const response = await requestJson(url, run, { "X-api-key": key }, config);
  if (response.code !== 0)
    throw new Error(
      `扶摇接口业务失败（code=${String(response.code)}）：${String(response.message ?? "未知错误").slice(0, 180)}`,
    );
  const data = response.data as {
    timestamp?: number;
    item?: Record<string, unknown>[];
  } | null;
  if (!data || !Array.isArray(data.item) || !data.item.length)
    throw new Error("扶摇接口无可用记录");
  const common = { source: "扶摇金融数据", sourceUrl: url };
  const rows = data.item;
  if (step.tool === "market.history")
    assertNoConflicts(rows, "date_ms", ["close_price"]);
  if (step.tool === "finance.income" || step.tool === "finance.cashflow")
    assertNoConflicts(rows, "period_end_ms", [
      "net_profit",
      "operating_income",
      "act_cash_flow_net",
    ]);
  if (step.tool === "market.history") {
    const series = rows
      .map((r) => ({ date: asDate(r.date_ms), value: numeric(r.close_price) }))
      .filter(
        (r): r is { date: string; value: number } =>
          r.value !== null &&
          r.value > 0 &&
          r.date >= intent.start &&
          r.date <= intent.end,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!series.length) throw new Error("行情字段缺失或不在研究日期范围内");
    return [
      base(step, run, {
        ...common,
        label: "区间末日收盘价",
        value: series.at(-1)!.value,
        unit: s.kind === "index" ? "点" : "元/股",
        asOf: series.at(-1)!.date,
        field: `data.item[date=${series.at(-1)!.date}].close_price`,
        basis:
          s.kind === "index"
            ? "日线指数点位"
            : "前复权日线收盘价；按当前复权口径重述，非严格历史可知价格",
        raw: response,
        series,
      }),
    ];
  }
  if (step.tool === "market.snapshot" || step.tool === "finance.valuation") {
    const row = rows.find((x) => x.thscode === s.code);
    if (!row) throw new Error("返回证券代码与研究标的不一致");
    const fields =
      step.tool === "finance.valuation"
        ? [
            ["pe_ttm", "市盈率 TTM", "倍", "滚动十二个月利润口径"],
            ["pb_mrq", "市净率 MRQ", "倍", "最近报告期净资产口径"],
          ]
        : [
            [
              "last_price",
              "最新价",
              s.kind === "index" ? "点" : "元/股",
              "行情快照",
            ],
          ];
    return fields.map(([field, label, unit, basis]) =>
      base(step, run, {
        ...common,
        label,
        value: numeric(row[field]),
        unit,
        asOf: asDate(row.timestamp ?? data.timestamp),
        field: `data.item[thscode=${s.code}].${field}`,
        basis,
        raw: response,
      }),
    );
  }
  const eligible = rows
    .filter(
      (r) =>
        typeof r.period_end_ms === "number" &&
        typeof r.report_date_ms === "number" &&
        r.period_end_ms <= Date.parse(intent.end + "T23:59:59.999+08:00") &&
        r.report_date_ms <= Date.parse(intent.end + "T23:59:59.999+08:00"),
    )
    .sort((a, b) => Number(b.period_end_ms) - Number(a.period_end_ms))
    .slice(0, intent.years);
  if (eligible.length < intent.years)
    event(
      run,
      "data_gap",
      `财报仅覆盖 ${eligible.length} 年，目标需要 ${intent.years} 年`,
      "财报年份不足，不能声称完成完整多期研究。",
    );
  if (!eligible.length)
    throw new Error("没有在研究截止日前已披露、且带报告期与披露日的财报。");
  const result: Evidence[] = [];
  for (const row of eligible) {
    const fields =
      step.tool === "finance.income"
        ? [
            ["operating_income", "营业收入"],
            ["net_profit", "合并净利润"],
          ]
        : [["act_cash_flow_net", "经营现金流净额"]];
    for (const [field, label] of fields)
      result.push(
        base(step, run, {
          ...common,
          label,
          value: numeric(row[field]),
          unit: "元",
          asOf: asDate(row.period_end_ms),
          field: `data.item[period_end_ms=${row.period_end_ms}].${field}`,
          basis: `年度合并财报；报告期末 ${asDate(row.period_end_ms)}；披露日 ${asDate(row.report_date_ms)}`,
          raw: { ...response, data: { ...data, item: [row] } },
        }),
      );
  }
  return result;
}
function demoData(step: Step, run: Run): Evidence[] {
  const s = step.security!,
    intent = run.intent!;
  const seed = Number(s.code.slice(0, 6)) % 71;
  const common = {
    source: "XBuddy 构造数据（演示）",
    sourceUrl: "",
    note: "此数值为程序构造，仅用于功能验证，不代表该证券真实财务或价格。",
  };
  if (step.tool === "market.history" || step.tool === "market.snapshot") {
    const series: NonNullable<Evidence["series"]> = [];
    const day = new Date(intent.start);
    let index = 0;
    while (day.toISOString().slice(0, 10) <= intent.end && index < 800) {
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
        series.push({
          date: day.toISOString().slice(0, 10),
          value: Number(
            (
              (100 + seed) * (1 + index * 0.00035) +
              Math.sin(index / 12 + seed) * 7 +
              Math.cos(index / 31) * 4
            ).toFixed(2),
          ),
        });
        index++;
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
    const last = series.at(-1);
    return [
      base(step, run, {
        ...common,
        label: "区间末日收盘价",
        value: last?.value ?? null,
        unit: s.kind === "index" ? "点" : "元/股",
        asOf: last?.date ?? intent.end,
        field: "synthetic.prices[].close",
        basis: "构造的前复权日线；工作日序列未应用真实交易日历",
        raw: { generator: "deterministic-synthetic-v1", seed, rows: series },
        series,
      }),
    ];
  }
  const latestYear = Number(intent.end.slice(0, 4)) - 1;
  const result: Evidence[] = [];
  const count = step.tool === "finance.valuation" ? 1 : intent.years;
  for (let offset = 0; offset < count; offset++) {
    const year = latestYear - offset;
    const growth = 1 - Math.min(offset * 0.07, 0.4);
    const values: Record<string, [string, string, number, string][]> = {
      "finance.income": [
        ["operating_income", "营业收入", (100 + seed) * 1e8 * growth, "元"],
        ["net_profit", "合并净利润", (20 + seed / 3) * 1e8 * growth, "元"],
      ],
      "finance.cashflow": [
        [
          "act_cash_flow_net",
          "经营现金流净额",
          (15 + seed / 2) * 1e8 * growth,
          "元",
        ],
      ],
      "finance.valuation": [
        ["pe_ttm", "市盈率 TTM", 15 + seed / 4, "倍"],
        ["pb_mrq", "市净率 MRQ", 2 + seed / 30, "倍"],
      ],
    };
    for (const [field, label, value, unit] of values[step.tool] ?? [])
      result.push(
        base(step, run, {
          ...common,
          label,
          value,
          unit,
          asOf:
            step.tool === "finance.valuation" ? intent.end : `${year}-12-31`,
          field: `synthetic.${year}.${field}`,
          basis:
            step.tool === "finance.valuation"
              ? "构造估值快照；TTM/MRQ见字段名"
              : "构造年度合并财报；披露时点仅用于演示，不模拟真实披露日历",
          raw: { [field]: value, year, synthetic: true },
        }),
      );
  }
  return result;
}
export function computeMetrics(run: Run, step: Step): Evidence[] {
  const result: Evidence[] = [];
  const make = (
    source: Evidence,
    label: string,
    value: number,
    unit: string,
    formula: string,
    inputs: Evidence[],
    basis: string,
  ) => {
    result.push({
      ...source,
      id: uid("ev"),
      stepId: step.id,
      label,
      value: Number(value.toFixed(4)),
      unit,
      formula,
      inputIds: inputs.map((x) => x.id),
      field: "derived." + label,
      basis,
      raw: {
        formula,
        inputs: inputs.map((x) => ({ id: x.id, value: x.value, asOf: x.asOf })),
      },
      series: undefined,
      observations: undefined,
      source: "XBuddy 指标计算",
      sourceUrl: "",
      quality: inputs.some((x) => x.quality === "demo")
        ? "demo"
        : inputs.some((x) => x.quality === "stale")
          ? "stale"
          : "verified",
    });
  };
  for (const evidence of run.evidence) {
    if (
      evidence.observations &&
      evidence.observations.length > 1 &&
      numericEvidence(evidence)
    ) {
      const points = evidence.observations,
        first = points[0],
        last = points.at(-1)!;
      make(
        evidence,
        `${evidence.label} · 区间变化`,
        last.value - first.value,
        evidence.unit === "%" ? "个百分点" : evidence.unit,
        "末期观测值 - 首期观测值",
        [evidence],
        `${first.date} 至 ${last.date}，${points.length} 个观测；${evidence.basis}；不做收益率或交易日年化解释`,
      );
    }
    if (
      evidence.series &&
      evidence.series.length > 1 &&
      evidence.value !== null &&
      numericEvidence(evidence)
    ) {
      const series = evidence.series;
      const first = series[0].value,
        last = series.at(-1)!.value;
      if (first <= 0) continue;
      let peak = first,
        drawdown = 0;
      const returns: number[] = [];
      for (let i = 0; i < series.length; i++) {
        peak = Math.max(peak, series[i].value);
        if (peak > 0) drawdown = Math.min(drawdown, series[i].value / peak - 1);
        if (i > 0 && series[i - 1].value > 0)
          returns.push(series[i].value / series[i - 1].value - 1);
      }
      const basis = `${series[0].date} 至 ${series.at(-1)!.date}，${series.length} 个实际样本；${evidence.basis}`;
      make(
        evidence,
        "区间涨跌幅",
        (last / first - 1) * 100,
        "%",
        "(末日收盘价 / 首日收盘价 - 1) × 100",
        [evidence],
        basis,
      );
      make(
        evidence,
        "最大回撤",
        drawdown * 100,
        "%",
        "min(当日收盘价 / 截至当日最高收盘价 - 1) × 100",
        [evidence],
        basis,
      );
      if (returns.length > 1) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance =
          returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
          (returns.length - 1);
        make(
          evidence,
          "年化波动率",
          Math.sqrt(variance * 252) * 100,
          "%",
          "日收益率样本标准差 × √252 × 100",
          [evidence],
          basis + "；按252交易日年化，非未来波动预测",
        );
      }
    }
  }
  for (const cash of run.evidence.filter(
    (e) =>
      e.label === "经营现金流净额" && e.value !== null && numericEvidence(e),
  )) {
    const profit = run.evidence.find(
      (e) =>
        e.security.code === cash.security.code &&
        e.asOf === cash.asOf &&
        e.label === "合并净利润" &&
        e.value !== null &&
        numericEvidence(e),
    );
    if (profit && profit.value !== 0)
      make(
        cash,
        "现金利润比",
        cash.value! / profit.value!,
        "倍",
        "经营现金流净额 / 同期合并净利润",
        [cash, profit],
        `同一年度 ${cash.asOf}，合并口径；利润为负时比例不代表盈利质量`,
      );
  }
  return result;
}
