import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const initial = await fetch(base + "/api/research");
const cookie = initial.headers.get("set-cookie").split(";")[0];
async function api(body) {
  const response = await fetch(base + "/api/research", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: base,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data.run;
}
let r = await api({
  action: "create",
  goal: "研究沪深300近三个月的走势与最大回撤，输出简短摘要。",
  mode: "live",
  maxCalls: 5,
});
r = await api({ action: "advance", id: r.id });
r = await api({ action: "start", id: r.id });
for (let i = 0; i < 6 && r.status !== "completed"; i++)
  r = await api({ action: "advance", id: r.id });
console.log(
  JSON.stringify(
    {
      status: r.status,
      mode: r.mode,
      planner: r.planner,
      calls: r.usage.calls,
      steps: r.steps.map((s) => ({
        tool: s.tool,
        status: s.status,
        error: s.error,
      })),
      evidence: r.evidence.map((e) => ({
        label: e.label,
        source: e.source,
        asOf: e.asOf,
        unit: e.unit,
        quality: e.quality,
      })),
      gaps: r.report?.gaps,
    },
    null,
    2,
  ),
);
assert.equal(r.status, "completed");
assert.ok(
  r.evidence.some(
    (e) =>
      ["腾讯财经公开行情（备用）", "扶摇金融数据"].includes(e.source) &&
      e.quality === "verified",
  ),
);
assert.ok(r.evidence.some((e) => e.label === "最大回撤" && e.unit === "%"));
assert.equal(r.evidence[0].security.kind, "index");
