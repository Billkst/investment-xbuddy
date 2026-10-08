import test from "node:test";
import assert from "node:assert/strict";
import { GuestWorkspace, GUEST_STORAGE_KEY } from "../lib/research/guest.ts";
import type { Run } from "../lib/research/types.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
async function runOf(result: ReturnType<GuestWorkspace["request"]>) {
  const value = await result;
  assert.ok("run" in value);
  return value.run;
}

test("guest completes a personalized research with approval and refresh without external requests", async () => {
  const saved = storage();
  let workspace = new GuestWorkspace(saved);
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("unexpected outbound request");
  };
  try {
    let run = await runOf(
      workspace.request({
        action: "create",
        goal: "比较贵州茅台和五粮液近三年现金流与估值",
        mode: "demo",
        maxCalls: 1,
      }),
    );
    run = await runOf(workspace.request({ action: "advance", id: run.id }));
    assert.equal(run.status, "ready");
    run = await runOf(workspace.request({ action: "start", id: run.id }));
    let approvals = 0;
    for (let i = 0; i < 40 && run.status !== "completed"; i++) {
      workspace = new GuestWorkspace(saved);
      run = await runOf(workspace.request(undefined, run.id));
      if (run.approval) {
        approvals++;
        run = await runOf(
          workspace.request({
            action: "approve",
            id: run.id,
            approvalId: run.approval.id,
          }),
        );
      } else
        run = await runOf(workspace.request({ action: "advance", id: run.id }));
    }
    assert.equal(run.status, "completed");
    assert.ok(approvals > 0);
    assert.equal(run.report?.mode, "demo");
    assert.ok(run.evidence.length > 5);
    assert.equal(run.usage.modelCalls, 0);
    assert.equal(requests, 0);
    assert.ok(
      run.report?.findings.every((f) =>
        f.evidenceIds.every((id) => run.evidence.some((e) => e.id === id)),
      ),
    );
    const other = await runOf(
      workspace.request({
        action: "create",
        goal: "研究沪深300近三个月最大回撤",
        mode: "demo",
      }),
    );
    const planned = await runOf(
      workspace.request({ action: "advance", id: other.id }),
    );
    assert.ok(planned.steps.some((s) => s.tool === "market.history"));
    assert.ok(planned.steps.every((s) => !s.tool.startsWith("finance.")));
  } finally {
    globalThis.fetch = original;
  }
});

test("guest cannot access live providers, memories or another browser's run", async () => {
  const saved = storage();
  const workspace = new GuestWorkspace(saved);
  await assert.rejects(
    workspace.request({
      action: "create",
      goal: "贵州茅台价格走势",
      mode: "live",
    }),
    /真实数据研究请先登录/,
  );
  await assert.rejects(
    workspace.request({ action: "memory_add", text: "偏好" }),
    /需要登录/,
  );
  const run = await runOf(
    workspace.request({
      action: "create",
      goal: "贵州茅台价格走势",
      mode: "demo",
    }),
  );
  await assert.rejects(
    new GuestWorkspace(storage()).request(undefined, run.id),
    /没有这条临时研究/,
  );
  const tampered = JSON.parse(saved.getItem(GUEST_STORAGE_KEY)!) as Run[];
  tampered[0].mode = "live";
  saved.setItem(GUEST_STORAGE_KEY, JSON.stringify(tampered));
  await assert.rejects(
    workspace.request({ action: "advance", id: run.id }),
    /记录无法读取/,
  );
});

test("guest clear recovers invalid storage and failed writes leave previous records intact", async () => {
  const saved = storage();
  saved.setItem(GUEST_STORAGE_KEY, "bad JSON");
  const workspace = new GuestWorkspace(saved);
  assert.throws(() => workspace.listRuns(), /记录无法读取/);
  await workspace.request({ action: "guest_clear" });
  assert.deepEqual(workspace.listRuns(), []);
  const run = await runOf(
    workspace.request({
      action: "create",
      goal: "贵州茅台价格走势",
      mode: "demo",
    }),
  );
  const before = saved.getItem(GUEST_STORAGE_KEY);
  const full = new GuestWorkspace({
    ...saved,
    setItem() {
      throw new Error("quota");
    },
  });
  await assert.rejects(
    full.request({ action: "advance", id: run.id }),
    /存储空间不足/,
  );
  assert.equal(saved.getItem(GUEST_STORAGE_KEY), before);
});

test("guest operations serialize without losing steps or approvals", async () => {
  const workspace = new GuestWorkspace(storage());
  const run = await runOf(
    workspace.request({
      action: "create",
      goal: "贵州茅台近一年价格与估值",
      mode: "demo",
    }),
  );
  await workspace.request({ action: "advance", id: run.id });
  await workspace.request({ action: "start", id: run.id });
  await Promise.all([
    workspace.request({ action: "advance", id: run.id }),
    workspace.request({ action: "pause", id: run.id }),
  ]);
  const paused = await runOf(workspace.request(undefined, run.id));
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps.filter((s) => s.status === "succeeded").length, 1);
  assert.equal(paused.steps[0].attempts, 1);
});
