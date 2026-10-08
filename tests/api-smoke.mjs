import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const checks = [];
const initial = await fetch(base + "/api/research");
const cookie = initial.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "anonymous workspace cookie");
assert.match(initial.headers.get("set-cookie"), /HttpOnly/);
assert.match(initial.headers.get("set-cookie"), /SameSite=Lax/);
async function api(body, id, session = cookie) {
  if (body?.action === "create")
    body = { ...body, mode: "live", modelSelection: { source: "rules" } };
  const r = await fetch(base + "/api/research" + (id ? "?id=" + id : ""), {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: {
      ...(session ? { Cookie: session } : {}),
      ...(body ? { "Content-Type": "application/json", Origin: base } : {}),
    },
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
  return data;
}
for (const body of [
  { action: "create", goal: "研究贵州茅台", mode: "demo" },
  {
    action: "create",
    goal: "研究贵州茅台",
    mode: "live",
    fault: "tool_failure",
  },
]) {
  const rejected = await fetch(base + "/api/research", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(rejected.status, 400);
}
checks.push("public API rejects synthetic data and fault injection");
const boot = await api();
assert.equal(boot.access, "anonymous");
assert.ok(!("user" in boot) && !("owner" in boot));
checks.push("anonymous bootstrap and HttpOnly session without account");
await assert.rejects(
  api(
    { action: "create", goal: "茅台走势测试", mode: "demo" },
    undefined,
    false,
  ),
  (e) => e.status === 428,
);
checks.push("requests without a workspace capability rejected");
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
const second = await fetch(base + "/api/research");
const secondCookie = second.headers.get("set-cookie").split(";")[0];
assert.notEqual(secondCookie, cookie);
assert.deepEqual((await api(undefined, undefined, secondCookie)).runs, []);
for (const body of [
  undefined,
  { action: "advance", id: run.id },
  { action: "pause", id: run.id },
  { action: "memory_add", sourceRunId: run.id, text: "foreign" },
]) {
  await assert.rejects(api(body, body ? undefined : run.id, secondCookie));
}
checks.push("separate browsers cannot read or mutate another workspace");
const foreignMemory = (
  await api(
    { action: "memory_add", text: "另一浏览器的研究偏好" },
    undefined,
    secondCookie,
  )
).memory;
await api({ action: "memory_delete", memoryId: foreignMemory.id });
assert.ok(
  (await api(undefined, undefined, secondCookie)).memories.some(
    (m) => m.id === foreignMemory.id,
  ),
);
checks.push("memory ownership enforced without accounts");
const forged = await fetch(base + "/api/research", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: base,
    "oai-authenticated-user-id": "forged-user",
    "oai-authenticated-user-email": "fake@example.invalid",
  },
  body: JSON.stringify({
    action: "create",
    goal: "研究贵州茅台",
    mode: "demo",
  }),
});
assert.equal(forged.status, 428);
for (const invalid of [
  cookie + "; " + cookie,
  "xbuddy-workspace-dev=invalid",
  "xbuddy-workspace-dev=" + "a".repeat(64),
]) {
  await assert.rejects(
    api({ action: "memory_add", text: "invalid" }, undefined, invalid),
    (e) => e.status === 428,
  );
}
checks.push(
  "forged account headers and invalid workspace cookies confer no access",
);
const live = (
  await api({ action: "create", goal: "沪深300近一月走势", mode: "live" })
).run;
assert.equal(live.mode, "live");
checks.push(
  "live mode unlocked without login; provider availability is independent",
);
const clearing = await fetch(base + "/api/research", {
  method: "POST",
  headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "workspace_clear" }),
});
assert.equal(clearing.status, 200);
const rotated = clearing.headers.get("set-cookie").split(";")[0];
assert.notEqual(rotated, cookie);
assert.deepEqual((await api(undefined, undefined, rotated)).runs, []);
assert.deepEqual((await api(undefined, undefined, rotated)).memories, []);
await assert.rejects(api(undefined, run.id, rotated));
await assert.rejects(
  api({ action: "memory_add", text: "replay" }, undefined, cookie),
  (e) => e.status === 428,
);
assert.ok(
  (await api(undefined, undefined, secondCookie)).memories.some(
    (m) => m.id === foreignMemory.id,
  ),
);
checks.push("clear revokes old capability and keeps other visitors intact");
const result = {
  passed: checks.length,
  checks,
  completedRun: run.id,
  financialSource: "Fuyao real account",
  realModelTested: false,
};
console.log(JSON.stringify(result, null, 2));
