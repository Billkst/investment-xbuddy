import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const checks = [];
const login = await fetch(base + "/signin-with-chatgpt?return_to=/", {
  redirect: "manual",
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "local sign-in cookie");
async function api(body, id, auth = true) {
  const r = await fetch(base + "/api/research" + (id ? "?id=" + id : ""), {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: {
      ...(auth ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json", Origin: base } : {}),
    },
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
  return data;
}
const boot = await api();
assert.equal(boot.authenticated, true);
checks.push("authenticated bootstrap");
await assert.rejects(
  api(
    { action: "create", goal: "茅台走势测试", mode: "demo" },
    undefined,
    false,
  ),
  (e) => e.status === 401,
);
checks.push("unauthenticated writes rejected");
const cross = await fetch(base + "/api/research", {
  method: "POST",
  headers: {
    Cookie: cookie,
    "Content-Type": "application/json",
    Origin: "https://example.invalid",
  },
  body: JSON.stringify({
    action: "create",
    goal: "茅台走势测试",
    mode: "demo",
  }),
});
assert.equal(cross.status, 403);
checks.push("cross-site writes rejected");
const memory = (
  await api({ action: "memory_add", text: "验收偏好：关注现金流并输出摘要" })
).memory;
let run = (
  await api({
    action: "create",
    goal: "比较贵州茅台和五粮液最近三年现金流与估值",
    mode: "demo",
    maxCalls: 1,
  })
).run;
const send = async (action, extra = {}) => {
  const r = await api({ action, id: run.id, ...extra });
  run = r.run;
  return r;
};
await send("advance");
assert.equal(run.status, "ready");
assert.ok(run.memoryContext.some((m) => m.id === memory.id));
assert.equal(run.intent.output, "摘要");
checks.push("memory read into new plan");
await send("start");
await send("advance");
const oldEvidence = run.evidence.map((e) => e.id);
await send("pause");
assert.equal(run.status, "paused");
run = (await api(undefined, run.id)).run;
assert.ok(oldEvidence.every((id) => run.evidence.some((e) => e.id === id)));
await send("resume");
await send("advance");
assert.equal(run.status, "waiting_approval");
const approval = run.approval.id;
await send("advance");
assert.equal(run.usage.calls, 1);
checks.push("server budget gate");
await send("approve", { approvalId: approval });
for (let i = 0; i < 20 && run.status !== "completed"; i++) {
  if (run.approval) await send("approve", { approvalId: run.approval.id });
  else await send("advance");
}
assert.equal(run.status, "completed");
assert.equal(run.usage.calls, 6);
assert.ok(oldEvidence.every((id) => run.evidence.some((e) => e.id === id)));
checks.push("durable pause/resume and report");
assert.ok(
  run.report.findings.every((f) =>
    f.evidenceIds.every((id) => run.evidence.some((e) => e.id === id)),
  ),
);
checks.push("all citations resolve");
await send("compress");
assert.ok(run.context.summary.includes(run.evidence[0].id));
assert.ok(run.context.revision > 0);
checks.push("compression persisted");
await api({ action: "memory_delete", memoryId: memory.id });
assert.ok(!(await api()).memories.some((m) => m.id === memory.id));
checks.push("memory deletion");
// Two simultaneous requests must not repeat the same committed read-only step.
let concurrent = (
  await api({
    action: "create",
    goal: "茅台现金流研究",
    mode: "demo",
    maxCalls: 10,
  })
).run;
concurrent = (await api({ action: "advance", id: concurrent.id })).run;
await api({ action: "start", id: concurrent.id });
await Promise.allSettled([
  api({ action: "advance", id: concurrent.id }),
  api({ action: "advance", id: concurrent.id }),
]);
concurrent = (await api(undefined, concurrent.id)).run;
assert.equal(concurrent.steps[0].attempts, 1);
assert.equal(
  concurrent.evidence.filter((e) => e.label === "营业收入").length,
  1,
);
checks.push("concurrent advance does not duplicate step");
const result = {
  passed: checks.length,
  checks,
  completedRun: run.id,
  financialSource: "synthetic",
  realModelTested: false,
};
console.log(JSON.stringify(result, null, 2));
