import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const init = await fetch(base + "/api/research");
const cookie = init.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
async function api(body) {
  const response = await fetch(base + "/api/research", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, data.error);
  return data;
}
// This is a real model functional smoke test, not a concurrency/load test.
const goals = [
  "分析贵州茅台近一年的价格走势、波动与最大回撤，说明数据局限。",
  "研究中国最近一年CPI当月同比的变化，注明数据来源、频率和单位，输出简短摘要。",
  "比较贵州茅台和五粮液最近三年的盈利质量与估值，重点关注现金流。",
];
for (const [i, goal] of goals.entries()) {
  if (i) await new Promise((resolve) => setTimeout(resolve, 20000));
  let run = (
    await api({ action: "create", goal, modelSelection: { source: "site" } })
  ).run;
  run = (await api({ action: "advance", id: run.id })).run;
  console.log(
    JSON.stringify({
      case: i + 1,
      planner: run.planner,
      status: run.status,
      modelCalls: run.usage.modelCalls,
      tokens: run.usage.tokens,
      repairs: run.events.filter((e) => e.type === "plan_repair").length,
      reason: run.pauseReason,
      tools: run.steps.map((s) => s.tool),
    }),
  );
  assert.equal(run.planner, "model");
  assert.equal(run.status, "ready");
  assert.ok(!run.events.some((e) => e.type === "model_fallback"));
}
