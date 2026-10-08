import { callIfindTool, IFIND_ENDPOINT } from "../integrations/ifind.ts";
import {
  ifindCatalog,
  isIfindName,
  ifindMarkets,
  marketForGoal,
  quoteIndicators,
  type IfindName,
} from "../integrations/ifind-catalog.ts";
import {
  type Run,
  type Step,
  type Evidence,
  type RuntimeConfig,
  type Intent,
  consumeRequest,
  event,
  uid,
  now,
} from "./types.ts";
import { safeSourceUrl } from "./evidence.ts";
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function ifindArguments(
  name: IfindName,
  run: Pick<Run, "goal" | "intent">,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  const intent = run.intent!;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
  const market =
    typeof options.market === "string"
      ? options.market === "股票"
        ? "A股"
        : options.market
      : intent.market || marketForGoal(run.goal);
  if (
    [
      "get_security_indicators",
      "search_securities",
      "security_highfreq_quotes",
    ].includes(name) &&
    !(ifindMarkets as readonly string[]).includes(market)
  )
    throw new Error("iFinD 市场参数无效");
  const query = `${run.goal}\n本任务仅执行：${ifindCatalog[name].description}。查询范围：${intent.start} 至 ${intent.end}。保留数据日期、单位、来源与统计口径；不生成买卖建议。`;
  if (name === "get_security_indicators") return { market, query };
  if (name === "search_securities") {
    const selected = market === "A股" ? "股票" : market;
    if (!["股票", "基金", "港股", "美股"].includes(selected))
      throw new Error("当前筛选工具不支持此市场");
    return {
      market: selected,
      query: query + "\n最多返回5个符合用户原条件的候选，并说明筛选依据。",
    };
  }
  if (name === "search_news" || name === "search_notice")
    return { query, time_start: intent.start, time_end: intent.end, size: 5 };
  if (name === "search_trending_news") {
    if (intent.end < today)
      throw new Error("热点工具仅支持近期资讯；历史资讯请使用新闻检索。");
    const keyword =
      typeof options.keyword === "string"
        ? options.keyword.trim().slice(0, 40)
        : intent.securities.map((s) => s.name).join(" ");
    const scope = /6小时/.test(run.goal)
      ? "6小时"
      : /24小时|今日|今天/.test(run.goal)
        ? "24小时"
        : "近一周";
    return {
      size: 5,
      time_scope: scope,
      sensitive: "全部",
      ...(keyword ? { keyword } : {}),
    };
  }
  if (name === "security_highfreq_quotes") {
    if (intent.end < today)
      throw new Error("高频行情仅支持当日，历史日频请使用证券指标查询。");
    if (!["A股", "基金", "债券", "指数"].includes(market))
      throw new Error("高频行情不支持当前市场");
    const symbols = intent.securities.length
      ? intent.securities.map((s) => s.code).join(",")
      : typeof options.symbols === "string"
        ? options.symbols.trim()
        : "";
    if (
      !symbols ||
      symbols.length > 160 ||
      symbols.split(/[,，]/).length > 4 ||
      /https?:|[\n\r<>]/i.test(symbols)
    )
      throw new Error("请为实时行情明确最多4个证券代码或名称。");
    const data_mode = /分时|分钟|高频/.test(run.goal)
      ? "highfreq"
      : "real_time";
    const indicators =
      typeof options.indicators === "string"
        ? options.indicators
        : data_mode === "highfreq"
          ? "收盘价,成交量"
          : "最新价,涨跌幅";
    if (
      indicators.split(",").length > 5 ||
      indicators.split(",").some((s) => !quoteIndicators.includes(s))
    )
      throw new Error("高频指标参数无效或超过5项");
    const interval = Number(options.interval ?? 1);
    if (![1, 3, 5, 10, 15, 30, 60].includes(interval))
      throw new Error("高频采样间隔无效");
    return {
      market,
      symbols,
      indicators,
      data_mode,
      ...(data_mode === "highfreq" ? { interval } : {}),
    };
  }
  if (name === "get_stock_summary") return { query: run.goal };
  return { query };
}
function date(value: unknown): string {
  if (typeof value !== "string") return "未披露";
  const match = value.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (!match) return "未披露";
  const d = `${match[1]}-${match[2]}-${match[3]}`;
  return !Number.isNaN(Date.parse(d)) &&
    new Date(d).toISOString().slice(0, 10) === d
    ? d
    : "未披露";
}
function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function envelope(result: Record<string, unknown>): {
  data: unknown;
  path: string;
} {
  if (result.isError === true) throw new Error("iFinD 工具返回执行错误");
  const content = Array.isArray(result.content) ? result.content : [];
  let payload: unknown = result.structuredContent;
  let path = "structuredContent";
  if (!payload) {
    const index = content.findIndex(
      (c) => record(c) && c.type === "text" && typeof c.text === "string",
    );
    if (index < 0) throw new Error("iFinD 未返回文本或结构化数据");
    payload = decode((content[index] as Record<string, unknown>).text);
    path = `content[${index}].text (JSON解码)`;
  }
  if (!record(payload) || payload.code !== 1)
    throw new Error("iFinD 业务接口未返回成功数据，请核对权限与查询条件。");
  let data = decode(payload.data);
  path += ".data";
  if (record(data) && "code" in data && data.code !== 1)
    throw new Error("iFinD 内层业务接口返回失败，未生成正常研究证据。");
  if (record(data) && "data" in data && !data.answer && !data.tables) {
    data = decode(data.data);
    path += ".data (JSON解码)";
  }
  return { data, path };
}
function rowsFromMarkdown(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    )
    .filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
}
function numericCell(value: string, unit: string): number | null {
  const match = value
    .replaceAll(",", "")
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)(万亿|亿|万)?(%|元|美元|港元|点|倍)?$/);
  if (!match) return null;
  if (match[3] && match[3] !== unit) return null;
  const scale =
    match[2] === "万亿"
      ? 1e12
      : match[2] === "亿"
        ? 1e8
        : match[2] === "万"
          ? 1e4
          : 1;
  if (scale !== 1 && /万|亿/.test(unit)) return null;
  const n = Number(match[1]) * scale;
  return Number.isFinite(n) ? n : null;
}
export function parseIfindEvidence(
  name: IfindName,
  result: Record<string, unknown>,
  step: Step,
  run: Run,
): Evidence[] {
  const { data, path } = envelope(result),
    intent = run.intent!;
  const subject = step.security ?? {
    code: `topic:${name}:${intent.topic || run.goal}`.slice(0, 180),
    name: intent.topic || run.goal.slice(0, 70),
    kind: "topic" as const,
  };
  const base = {
    stepId: step.id,
    security: subject,
    retrievedAt: now(),
    source: "iFinD MCP",
    sourceUrl: IFIND_ENDPOINT,
    unit: "",
    value: null,
    asOf: "未披露",
    basis: ifindCatalog[name].description,
  };
  const make = (
    extra: Partial<Evidence> &
      Pick<Evidence, "label" | "raw" | "field" | "quality">,
  ): Evidence => ({ ...base, id: uid("ev"), ...extra });
  if (
    typeof data === "string" &&
    /未能识别|无有效|未找到|没有查询|查询失败|查询结果为空|暂无数据/.test(data)
  )
    throw new Error(
      "iFinD 未返回符合查询条件的数据，请调整标的、指标或日期后重试。",
    );
  if (
    name === "search_news" ||
    name === "search_notice" ||
    name === "search_trending_news"
  ) {
    const rows = Array.isArray(data)
      ? data
      : record(data) && Array.isArray(data.result)
        ? data.result
        : [];
    const evidence: Evidence[] = [];
    let excluded = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!record(row)) continue;
      const title = row["资讯标题"] ?? row["公告标题"];
      const text = row["资讯内容"] ?? row["公告片段内容"];
      if (typeof title !== "string" || typeof text !== "string" || !text.trim())
        continue;
      const published = date(row["日期"]);
      if (
        published !== "未披露" &&
        (published < intent.start || published > intent.end)
      ) {
        excluded++;
        continue;
      }
      if (evidence.length >= 5) {
        excluded++;
        continue;
      }
      const link = safeSourceUrl(row.URL);
      evidence.push(
        make({
          label: title.slice(0, 180),
          text: text.slice(0, 5000),
          evidenceKind: "excerpt",
          asOf: published,
          source:
            typeof row["信息来源"] === "string"
              ? `iFinD MCP · ${row["信息来源"]}`
              : "iFinD MCP · " +
                (name === "search_notice" ? "公告原文片段" : "新闻原文片段"),
          sourceUrl: link || IFIND_ENDPOINT,
          quality: published === "未披露" ? "unverified" : "verified",
          field: `${path}${record(data) ? ".result" : ""}[${i}]`,
          raw: {
            tool: name,
            arguments: step.parameters,
            path: `${path}[${i}]`,
            record: row,
          },
          basis: `发布于 ${published}；检索区间 ${intent.start} 至 ${intent.end}；仅为来源记载，不代表独立核实报道观点`,
          note: `仅保存接口返回片段，不是全文。${!link ? "接口未提供原文URL，可按标题查询原始披露。" : ""}${published === "未披露" ? "缺少独立发布时间，不从URL或获取时间推断，不能作为已核验事实。" : ""}${text.length > 5000 ? "展示摘录截至5000字，完整返回片段保留于原始记录。" : ""}`,
        }),
      );
    }
    if (excluded)
      event(
        run,
        "data_gap",
        "已排除超出日期范围或条数限制的检索结果",
        `${excluded} 条；请求最多5条。`,
      );
    if (!evidence.length)
      throw new Error("iFinD 未返回研究日期范围内的有效新闻或公告片段。");
    return evidence;
  }
  if (name === "search_edb") {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const list = block ? decode(block[1]) : [];
    const selected = Array.isArray(list) ? list.slice(0, 20) : [];
    if (!selected.length) throw new Error("iFinD 未返回可识别的指标目录。");
    return [
      make({
        label: "候选经济指标目录",
        evidenceKind: "discovery",
        text: JSON.stringify(selected, null, 2),
        quality: "unverified",
        field: path,
        raw: { tool: name, arguments: step.parameters, path, data },
        basis:
          "算法匹配的候选目录；包含指标名称、地区、来源、频率及覆盖期，不是已取到的数值",
        note: "目录可能包含其他地区、频率或预测指标，需结合具体需求核对后取数。",
      }),
    ];
  }
  if (name === "search_securities") {
    if (!record(data) || !Number(data.selectedSecuritiesCount))
      throw new Error("iFinD 筛选未找到候选证券；原条件保留，未擅自放宽条件。");
    const text = String(data.answer ?? "");
    if (!text) throw new Error("iFinD 筛选缺少结果内容。");
    const rows = rowsFromMarkdown(text);
    const shown = rows.length > 1 ? [rows[0], ...rows.slice(1, 6)] : [];
    return [
      make({
        label: "符合条件的候选证券",
        evidenceKind: "discovery",
        text: shown.length
          ? shown.map((r) => r.join(" | ")).join("\n")
          : text.slice(0, 6000),
        quality: "unverified",
        field: path,
        raw: { tool: name, arguments: step.parameters, path, data },
        basis: `接口返回 ${Number(data.selectedSecuritiesCount)} 个候选，展示前5个；排序为接口顺序，不是推荐排名`,
        note: "筛选结果仅供逐项核对，条件和单位以原始表头为准。未将候选中的数字作为已核验事实或投资建议。",
      }),
    ];
  }
  if (name === "fetch_edb" && record(data) && typeof data.answer === "string") {
    const rows = rowsFromMarkdown(data.answer);
    const headers = rows[0] ?? [];
    const dateCol = headers.findIndex((h) => /^(日期|时间)$/.test(h));
    const descriptions = Array.isArray(data.indicator_description)
      ? data.indicator_description.filter(record)
      : [];
    const evidence: Evidence[] = [];
    let excluded = 0;
    for (let c = 0; c < headers.length; c++) {
      if (c === dateCol) continue;
      const label = headers[c].replace(/[（(]单位[:：].*?[）)]/g, "").trim();
      const meta = descriptions.find((d) => d["指标名称"] === label);
      const unit =
        typeof meta?.["单位"] === "string"
          ? String(meta["单位"])
          : (headers[c].match(/单位[:：]\s*([^）)]+)/)?.[1]?.trim() ?? "");
      const points: {
        date: string;
        value: number;
        raw: string[];
        row: number;
      }[] = [];
      for (let i = 1; i < rows.length; i++) {
        const d = date(rows[i][dateCol]);
        if (d === "未披露" || d < intent.start || d > intent.end) {
          excluded++;
          continue;
        }
        const value = numericCell(rows[i][c] ?? "", unit);
        if (value !== null)
          points.push({ date: d, value, raw: rows[i], row: i });
      }
      points.sort((a, b) => a.date.localeCompare(b.date));
      if (!points.length) continue;
      if (
        points.some(
          (p, i) =>
            i > 0 &&
            p.date === points[i - 1].date &&
            p.value !== points[i - 1].value,
        )
      )
        throw new Error("iFinD 同一日期返回冲突经济指标值，不能生成正常结论。");
      const last = points.at(-1)!;
      const source =
        typeof meta?.["数据来源"] === "string"
          ? String(meta["数据来源"])
          : "未披露";
      const frequency =
        typeof meta?.["频率"] === "string" ? String(meta["频率"]) : "未披露";
      const headerUnit = headers[c].match(/单位[:：]\s*([^）)]+)/)?.[1]?.trim();
      const unitConflict = !!headerUnit && !!unit && headerUnit !== unit;
      const country = String(meta?.["国家地区"] ?? "");
      const countries = [
        "中国",
        "美国",
        "英国",
        "日本",
        "德国",
        "法国",
        "印度",
      ];
      const requestedCountries = countries.filter((x) => run.goal.includes(x));
      const scopeConflict =
        requestedCountries.length > 0 && !requestedCountries.includes(country);
      const metricConflict = ["CPI", "PPI", "GDP", "PMI"].some(
        (x) =>
          new RegExp(x, "i").test(run.goal) && !new RegExp(x, "i").test(label),
      );
      const quality =
        !unitConflict &&
        !scopeConflict &&
        !metricConflict &&
        unit &&
        source !== "未披露" &&
        frequency !== "未披露" &&
        !/预测/.test(label)
          ? "verified"
          : "unverified";
      evidence.push(
        make({
          label,
          value: last.value,
          observations: points.map((p) => ({ date: p.date, value: p.value })),
          unit,
          asOf: last.date,
          quality,
          evidenceKind: "numeric",
          source: `iFinD MCP · ${source}`,
          field: `${path}.answer[日期=${last.date}][${headers[c]}]`,
          raw: {
            tool: name,
            arguments: step.parameters,
            path,
            data,
            selectedRows: points.map((p) => ({ row: p.row, original: p.raw })),
          },
          basis: `${String(meta?.["国家地区"] ?? "地区未披露")}；频率 ${frequency}；${label}；按实际观测期过滤 ${intent.start} 至 ${intent.end}；${points.length} 个样本`,
          note: `${unitConflict ? "表头与指标元数据单位冲突；" : ""}${scopeConflict || metricConflict ? "返回的地区或指标与研究目标不一致；" : ""}保留当前接口版本的观测值；未提供历次修订及发布日期，不能声称重建当时已知数据。`,
        }),
      );
      // Dated observations remain in raw; no equity return/252-day metrics on economic series.
    }
    if (excluded)
      event(
        run,
        "data_gap",
        "已过滤宏观接口返回的范围外观测值",
        `${excluded} 项。按原始日期过滤，不使用额外年份扩充研究。`,
      );
    if (evidence.length) return evidence;
    throw new Error("iFinD 未返回请求区间内、可识别日期与数值的经济指标。");
  }
  if (
    name === "get_security_indicators" &&
    record(data) &&
    typeof data.answer === "string"
  ) {
    const rows = rowsFromMarkdown(data.answer),
      headers = rows[0] ?? [];
    const dateCol = headers.findIndex((h) => /^(日期|时间|报告期)$/.test(h));
    const codeCol = headers.findIndex((h) => /证券代码/.test(h));
    const nameCol = headers.findIndex((h) => /证券简称/.test(h));
    const metadata = record(data.indicators_params)
      ? data.indicators_params
      : {};
    const evidence: Evidence[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r],
        d = date(row[dateCol]);
      if (d === "未披露" || d < intent.start || d > intent.end) continue;
      const code = row[codeCol] ?? "";
      if (
        intent.securities.length &&
        !intent.securities.some((s) => s.code === code)
      )
        continue;
      if (code && !/^[A-Za-z0-9.\-]{1,25}$/.test(code)) continue;
      for (let c = 0; c < headers.length; c++) {
        if ([dateCol, codeCol, nameCol].includes(c)) continue;
        const unit =
          headers[c].match(/单位[:：]\s*([^）)]+)/)?.[1]?.trim() ?? "";
        const label = headers[c].replace(/[（(]单位[:：].*?[）)]/g, "").trim();
        const value = numericCell(row[c] ?? "", unit);
        if (value === null) continue;
        const financial =
          /利润|收入|现金流|资产|负债|ROE|ROA|报表|股东权益|净资产/i.test(
            label,
          );
        const quality = unit && !financial ? "verified" : "unverified";
        evidence.push(
          make({
            security: code
              ? { code, name: row[nameCol] || code, kind: "stock" }
              : subject,
            label,
            value,
            unit,
            asOf: d,
            evidenceKind: "numeric",
            quality,
            field: `${path}.answer[${r}][${c}]`,
            raw: {
              tool: name,
              arguments: step.parameters,
              path,
              headers,
              row,
              column: c,
              indicators_params: metadata,
            },
            basis: `${headers[c]}；${d}；原始单元格 ${row[c]}；指标参数 ${JSON.stringify(metadata[label] ?? {})}`,
            note: financial
              ? "财务指标未提供披露日期且可能含MRQ/单季度口径差异，不能作为截止日当时已知财报，已标为待核对。"
              : !unit
                ? "接口未提供明确单位，不能作为已核验数值。"
                : "数值及单位来自原始表头；保留当前接口返回口径，未验证历史修订。",
          }),
        );
        if (evidence.length >= 60) break;
      }
      if (evidence.length >= 60) {
        event(
          run,
          "data_gap",
          "证券指标证据达到60条展示上限",
          "请缩小日期或指标范围进一步研究。",
        );
        break;
      }
    }
    if (evidence.length) return evidence;
  }
  // Preserve the actual table and its limitations. No guessed units, disclosure dates or column swaps.
  const text =
    typeof data === "string"
      ? data
      : record(data) && typeof data.answer === "string"
        ? data.answer
        : JSON.stringify(data, null, 2);
  if (!text?.trim()) throw new Error("iFinD 返回空数据。");
  return [
    make({
      label: ifindCatalog[name].title,
      evidenceKind: "excerpt",
      text: text.slice(0, 12000),
      quality: "unverified",
      field: path,
      raw: { tool: name, arguments: step.parameters, path, data },
      basis:
        "保留工具返回原表与字段；尚未满足单位、数据时点或披露口径的完整核验要求",
      note:
        name === "get_security_indicators"
          ? "指标表可能包含额外列；财报未提供披露日时，不视作截止日当时已公开的财报。以原始表头、日期和indicators_params逐项核对。"
          : name === "security_highfreq_quotes"
            ? "行情接口返回time与指标字段，但没有单位声明；不猜测百分比倍率，不对分钟数据套用日频年化公式。"
            : "摘要字段可能缺少日期或存在列顺序异常；仅展示原始返回，不用于已核验事实。",
    }),
  ];
}
export async function executeIfind(
  step: Step,
  run: Run,
  config: RuntimeConfig,
): Promise<Evidence[]> {
  const name = step.tool.slice(6);
  if (!isIfindName(name)) throw new Error("未注册的iFinD工具");
  if (!config.ifindMcpApiKey)
    throw new Error("未配置 iFinD MCP 密钥，无法获取此项数据。");
  const parameters = ifindArguments(name, run, step.parameters);
  step.parameters = parameters;
  await config.onProgress?.(run);
  consumeRequest(run);
  await config.onProgress?.(run);
  await config.beforeFinancialCall?.();
  event(
    run,
    "request",
    "iFinD MCP 只读取数",
    `${name} · ${JSON.stringify(parameters)}`,
  );
  const result = await callIfindTool(
    config.ifindMcpApiKey,
    name,
    parameters,
    async () => {
      await config.onProgress?.(run);
    },
  );
  const evidence = parseIfindEvidence(name, result, step, run);
  if (
    new TextEncoder().encode(
      JSON.stringify({ ...run, evidence: [...run.evidence, ...evidence] }),
    ).byteLength > 750000
  )
    throw new Error(
      "研究原始证据达到存储上限，请缩小范围或用已有证据完成报告。",
    );
  return evidence;
}
