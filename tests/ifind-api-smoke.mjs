import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const init = await fetch(base + "/api/research");
const cookie = init.headers.get("set-cookie").split(";")[0];
async function api(body, id) {
  const r = await fetch(base + "/api/research" + (id ? "?id=" + id : ""), {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: {
      Cookie: cookie,
      ...(body ? { Origin: base, "Content-Type": "application/json" } : {}),
    },
  });
  const x = await r.json();
  if (!r.ok) throw Error(x.error);
  return x;
}
const cases = [
  {
    goal: "研究中国2025年12月CPI当月同比，注明来源和单位，简短摘要。",
    tool: "ifind.fetch_edb",
    model: true,
    verified: true,
  },
  {
    goal: "研究贵州茅台2026-09-01至2026-10-08的经营相关新闻，区分报道与推断。",
    tool: "ifind.search_news",
    verified: true,
  },
  {
    goal: "检索贵州茅台2025-03-01至2025-05-31披露的2024年年度报告，关注经营现金流原文。",
    tool: "ifind.search_notice",
    verified: true,
  },
  {
    goal: "筛选食品饮料行业市值大于1000亿元的A股，最多返回5只。",
    tool: "ifind.search_securities",
    scope: true,
  },
];
for (const c of cases.filter(
  (c) => !process.env.IFIND_CASES || process.env.IFIND_CASES.includes(c.tool),
)) {
  let run = (
    await api({
      action: "create",
      goal: c.goal,
      modelSelection: { source: c.model ? "site" : "rules" },
      maxCalls: 10,
    })
  ).run;
  run = (await api({ action: "advance", id: run.id })).run;
  assert.equal(
    run.status,
    "ready",
    JSON.stringify({
      goal: c.goal,
      status: run.status,
      clarification: run.intent?.clarification,
      events: run.events.filter((e) => e.type === "model_fallback"),
    }),
  );
  assert.ok(run.steps.some((s) => s.tool === c.tool));
  if (c.model)
    assert.equal(
      run.planner,
      "model",
      JSON.stringify(run.events.filter((e) => e.type === "model_fallback")),
    );
  run = (await api({ action: "start", id: run.id })).run;
  let approvalSeen = false;
  for (let i = 0; i < 20 && run.status !== "completed"; i++) {
    if (run.approval) {
      approvalSeen = true;
      run = (
        await api({
          action: "approve",
          id: run.id,
          approvalId: run.approval.id,
        })
      ).run;
    } else run = (await api({ action: "advance", id: run.id })).run;
  }
  assert.equal(run.status, "completed");
  assert.equal(
    run.steps.find((s) => s.tool === c.tool).status,
    "succeeded",
    JSON.stringify(run.steps),
  );
  assert.ok(run.evidence.some((e) => e.source.startsWith("iFinD")));
  if (c.verified)
    assert.ok(
      run.report.findings.some(
        (f) => f.kind === "fact" && f.evidenceIds.length,
      ),
    );
  if (c.scope) assert.ok(approvalSeen);
  assert.ok(
    run.report.findings.every((f) =>
      f.evidenceIds.every((id) => run.evidence.some((e) => e.id === id)),
    ),
  );
  const reloaded = (await api(undefined, run.id)).run;
  assert.deepEqual(reloaded.report, run.report);
  console.log(
    JSON.stringify({
      goal: c.goal,
      run: run.id,
      planner: run.planner,
      tools: run.steps.map((s) => s.tool),
      evidence: run.evidence.length,
      facts: run.report.findings.filter((f) => f.kind === "fact").length,
      inferences: run.report.findings.filter((f) => f.kind === "inference")
        .length,
      modelCalls: run.usage.modelCalls,
      modelWarnings: run.events
        .filter((e) => e.type === "model_fallback")
        .map((e) => e.detail),
      status: run.status,
    }),
  );
}
console.log("Selected iFinD research API scenarios passed");
