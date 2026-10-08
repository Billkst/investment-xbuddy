import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const initial = await fetch(base + "/api/research");
const cookie = initial.headers.get("set-cookie")?.split(";")[0];
const boot = await initial.json();
assert.ok(boot.config.model);
async function api(body) {
  const r = await fetch(base + "/api/research", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const test = await api({
  action: "model_test",
  modelSelection: { source: "site" },
});
assert.equal(test.ok, true);
let run = (
  await api({
    action: "create",
    goal: "研究贵州茅台近一个月的股价表现、最大回撤和波动风险，输出简短摘要",
    mode: "live",
    modelSelection: { source: "site" },
  })
).run;
run = (await api({ action: "advance", id: run.id })).run;
assert.equal(
  run.planner,
  "model",
  JSON.stringify(run.events.filter((e) => e.type === "model_fallback")),
);
assert.equal(run.status, "ready");
run = (await api({ action: "start", id: run.id })).run;
for (let i = 0; i < 15 && run.status !== "completed"; i++)
  run = (await api({ action: "advance", id: run.id })).run;
assert.equal(run.status, "completed");
assert.ok(
  run.report.findings.some((f) => f.kind === "inference"),
  "real model report interpretation",
);
assert.ok(run.evidence.every((e) => e.quality !== "demo"));
assert.ok(
  run.report.findings.every((f) =>
    f.evidenceIds.every((id) => run.evidence.some((e) => e.id === id)),
  ),
);
console.log(
  JSON.stringify({
    connection: test.ok,
    planner: run.planner,
    status: run.status,
    modelCalls: run.usage.modelCalls,
    tokens: run.usage.tokens,
    evidence: run.evidence.length,
    inferences: run.report.findings.filter((f) => f.kind === "inference")
      .length,
    data: "real financial source",
  }),
);
// BYOK metadata is persisted, the request's key and arbitrary URL are not.
const dummy = "test-not-a-real-provider-key";
let personal = (
  await api({
    action: "create",
    goal: "茅台走势",
    mode: "live",
    modelSelection: {
      source: "personal",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      apiKey: dummy,
      baseUrl: "https://attacker.invalid",
    },
    modelCredential: {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      apiKey: dummy,
    },
  })
).run;
assert.ok(!JSON.stringify(personal).includes(dummy));
assert.ok(!JSON.stringify(personal).includes("attacker.invalid"));
await assert.rejects(api({ action: "advance", id: personal.id }), /重新填写/);
personal = (await api({ action: "model_rules", id: personal.id })).run;
assert.equal(personal.modelSelection.source, "rules");
personal = (await api({ action: "advance", id: personal.id })).run;
assert.equal(personal.planner, "rules");
console.log(
  "BYOK metadata isolation, missing credential gate and explicit rule continuation passed.",
);
