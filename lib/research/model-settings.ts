import type { RuntimeConfig } from "./types.ts";

export const modelProviders = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/",
    requestOptions: { thinking: { type: "disabled" } },
  },
  qwen: {
    name: "通义千问 · 阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-flash",
    keyUrl: "https://bailian.console.aliyun.com/",
    requestOptions: { enable_thinking: false },
  },
  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.7-flash",
    keyUrl: "https://open.bigmodel.cn/",
    requestOptions: { thinking: { type: "disabled" } },
  },
  kimi: {
    name: "Kimi · 月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    keyUrl: "https://platform.kimi.com/",
    requestOptions: { thinking: { type: "disabled" } },
  },
  siliconflow: {
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
    keyUrl: "https://cloud.siliconflow.cn/",
    requestOptions: { enable_thinking: false },
  },
  doubao: {
    name: "豆包 · 火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-2-1-pro-260915",
    keyUrl: "https://console.volcengine.com/ark/",
    requestOptions: { thinking: { type: "disabled" } },
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    keyUrl: "https://console.groq.com/keys",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
} as const;
export function modelRequestOptions(
  baseUrl: string,
  model: string,
): Record<string, unknown> {
  const provider = Object.values(modelProviders).find(
    (p) => p.baseUrl.replace(/\/$/, "") === baseUrl.replace(/\/$/, ""),
  );
  if (
    provider &&
    provider.defaultModel === model &&
    "requestOptions" in provider
  )
    return provider.requestOptions;
  if (
    new URL(baseUrl).hostname === "api.groq.com" &&
    model.startsWith("openai/gpt-oss-")
  )
    return { reasoning_effort: "low", include_reasoning: false };
  return {};
}
export type ModelProvider = keyof typeof modelProviders;
export type ModelSelection =
  | { source: "site" }
  | { source: "rules" }
  | { source: "personal"; provider: ModelProvider; model: string };
export type ModelCredential = {
  provider: ModelProvider;
  model: string;
  apiKey: string;
};

// Rebuild a whitelist-only object. Extra fields (including apiKey/baseUrl)
// from the request must never be persisted with a run.
export function parseModelSelection(input: unknown): ModelSelection {
  if (input === undefined) return { source: "site" };
  if (!input || typeof input !== "object")
    throw new Error("请选择有效的模型来源");
  const value = input as Record<string, unknown>;
  if (value.source === "site" || value.source === "rules")
    return { source: value.source };
  if (
    value.source !== "personal" ||
    typeof value.provider !== "string" ||
    !Object.hasOwn(modelProviders, value.provider)
  )
    throw new Error("不支持的模型服务商");
  if (
    typeof value.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.model)
  )
    throw new Error("请填写有效的模型名称");
  return {
    source: "personal",
    provider: value.provider as ModelProvider,
    model: value.model,
  };
}
export function modelRuntime(
  selection: ModelSelection,
  credential: unknown,
  site: RuntimeConfig,
): RuntimeConfig {
  if (selection.source === "site") return { ...site };
  const clean = {
    ...site,
    llmApiKey: undefined,
    llmModel: undefined,
    llmBaseUrl: undefined,
  };
  if (selection.source === "rules") return clean;
  if (!credential || typeof credential !== "object")
    throw new Error(
      "本研究使用个人密钥，请在“模型设置”重新填写；刷新后密钥不会保留。",
    );
  const value = credential as Record<string, unknown>;
  if (value.provider !== selection.provider || value.model !== selection.model)
    throw new Error(
      "个人密钥的服务商或模型与本研究不一致，请在“模型设置”重新配置。",
    );
  if (
    typeof value.apiKey !== "string" ||
    !/^[\x21-\x7e]{16,512}$/.test(value.apiKey)
  )
    throw new Error("API key 格式无效，请检查后重新填写。");
  return {
    ...clean,
    llmBaseUrl: modelProviders[selection.provider].baseUrl,
    llmModel: selection.model,
    llmApiKey: value.apiKey,
  };
}
