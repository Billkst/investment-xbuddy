// Reviewed, read-only tools. Newly discovered server tools are never auto-executable.
export const ifindCatalog = {
  get_stock_summary: {
    title: "公司信息摘要",
    description: "A股公司最新概况、财务或估值摘要，不支持历史筛选",
    focus: "公司概况",
  },
  get_security_indicators: {
    title: "证券指标查询",
    description: "A股、港美股、基金、债券、指数及期货日频行情与财务指标",
    focus: "证券指标",
  },
  security_highfreq_quotes: {
    title: "实时与分时行情",
    description: "A股、基金、交易所债券、指数的当日Level1报价与分钟序列",
    focus: "实时行情",
  },
  search_news: {
    title: "财经新闻检索",
    description: "指定日期范围内的新闻片段、标题与来源",
    focus: "新闻与事件",
  },
  search_notice: {
    title: "公司公告检索",
    description: "按披露日期检索公司及基金公告原文片段",
    focus: "公告研究",
  },
  search_trending_news: {
    title: "热点事件检索",
    description: "最近6小时、24小时或一周热门资讯，不替代历史新闻",
    focus: "热点事件",
  },
  fetch_edb: {
    title: "宏观与行业取数",
    description: "按明确指标名称、地区、频率和日期查询经济数据",
    focus: "宏观与行业",
  },
  search_edb: {
    title: "经济指标发现",
    description: "搜索宏观行业指标目录；候选目录本身不是经济数值",
    focus: "指标发现",
  },
  search_securities: {
    title: "条件筛选证券",
    description: "股票、港美股或基金的条件筛选；仅返回候选，不提供买卖建议",
    focus: "条件筛选",
  },
} as const;
export type IfindName = keyof typeof ifindCatalog;
export function isIfindName(name: string): name is IfindName {
  return Object.hasOwn(ifindCatalog, name);
}
export const ifindMarkets = [
  "A股",
  "基金",
  "债券",
  "指数",
  "港股",
  "美股",
  "期货期权",
  "板块",
] as const;
export function marketForGoal(goal: string): string {
  if (/美股|纳斯达克|标普|AAPL|NVDA|TSLA/i.test(goal)) return "美股";
  if (/港股|港交所|\.HK\b/i.test(goal)) return "港股";
  if (/基金|ETF/i.test(goal)) return "基金";
  if (/债券|国债|转债/.test(goal)) return "债券";
  if (/期货|期权/.test(goal)) return "期货期权";
  if (/指数|沪深300|上证|创业板指/.test(goal)) return "指数";
  return "A股";
}
export const quoteIndicators = [
  "开盘价",
  "最高价",
  "最低价",
  "成交额",
  "成交量",
  "收盘价",
  "均价",
  "最新价",
  "涨跌",
  "涨跌幅",
  "换手率",
  "现额",
  "现量",
  "总市值",
  "振幅",
  "最新成交价",
  "现手",
  "内盘",
  "外盘",
  "委比",
  "委差",
  "量比",
  "总股本",
  "市净率",
  "1分钟涨跌幅",
  "3分钟涨跌幅",
  "5分钟涨跌幅",
  "流通市值",
  "市盈率TTM",
  "领先指数",
  "上涨家数",
  "下跌家数",
  "涨停家数",
  "跌停家数",
  "停牌家数",
  "IOPV净值估值",
  "折价",
  "MA均线5周期",
  "MA均线20周期",
  "KDJ随机指标K值",
  "KDJ随机指标D值",
  "KDJ随机指标J值",
  "MACD指标DIFF值",
  "MACD指标DEA值",
  "MACD指标MACD值",
  "RSI相对强弱指标6周期",
  "RSI相对强弱指标12周期",
  "日内累积涨跌幅",
];
