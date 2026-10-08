import { ifindCatalog, ifindMarkets } from "../integrations/ifind-catalog.ts";

function object(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
export function planSchema(ifind: boolean) {
  return object({
    securities: {
      type: "array",
      items: object({
        code: text,
        name: text,
        kind: { type: "string", enum: ["stock", "index"] },
      }),
    },
    topic: text,
    market: { type: "string", enum: [...ifindMarkets, "宏观"] },
    focus: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "价格与风险",
          "盈利质量",
          "估值",
          ...(ifind ? Object.values(ifindCatalog).map((t) => t.focus) : []),
        ],
      },
    },
    start: text,
    end: text,
    years: { type: "integer" },
    output: { type: "string", enum: ["摘要", "研究备忘录"] },
    limitations: { type: "array", items: text },
    clarification: nullableText,
    tasks: {
      type: "array",
      items: object({
        tool: {
          type: "string",
          enum: [
            "market.history",
            "market.snapshot",
            "finance.income",
            "finance.cashflow",
            "finance.valuation",
            ...(ifind
              ? Object.keys(ifindCatalog).map((t) => `ifind.${t}`)
              : []),
          ],
        },
        code: {
          ...nullableText,
          description: "扶摇任务填写计划内证券代码，iFinD任务填null",
        },
        parameters: object({
          market: { type: ["string", "null"], enum: [...ifindMarkets, null] },
          symbols: {
            ...nullableText,
            description:
              "分时查询证券代码或名称，逗号分隔最多4个，其余工具填null",
          },
          indicators: nullableText,
          interval: {
            type: ["integer", "null"],
            enum: [1, 3, 5, 10, 15, 30, 60, null],
          },
          keyword: nullableText,
        }),
      }),
    },
  });
}
export function supportsStrictPlan(baseUrl: string, model: string) {
  return (
    baseUrl.replace(/\/$/, "") === "https://api.groq.com/openai/v1" &&
    ["openai/gpt-oss-120b", "openai/gpt-oss-20b"].includes(model)
  );
}

export class ModelRequestError extends Error {
  retryAfterMs?: number;
  kind: "format" | "transient" | "fatal";
  constructor(
    message: string,
    kind: "format" | "transient" | "fatal",
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelRequestError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
