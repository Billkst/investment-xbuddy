import { env } from "cloudflare:workers";
import { reserveModelSql, type ModelBudgetBucket } from "./model-budget.ts";
import {
  type Run,
  type Memory,
  uid,
  now,
  event,
  checkpoint,
  StopError,
} from "./types.ts";
function db() {
  if (!env.DB) throw new Error("持久化服务不可用，请检查数据库绑定与迁移");
  return env.DB;
}
export async function hasWorkspace(owner: string) {
  return !!(await db()
    .prepare("SELECT id FROM research_workspaces WHERE id=? AND expires_at>?")
    .bind(owner, Date.now())
    .first());
}
export async function reserveModelBudget(
  buckets: ModelBudgetBucket[],
  tokens: number,
  quotaMessage = "本次模型调用已达到工作台或站点的额度限制，请稍后重试或切换规则模式。",
) {
  await db()
    .prepare("DELETE FROM model_usage WHERE expires_at<?")
    .bind(Date.now())
    .run();
  try {
    await db().batch(
      buckets.map((b) =>
        db()
          .prepare(reserveModelSql)
          .bind(b.bucket, tokens, b.expiresAt, b.callLimit, b.tokenLimit),
      ),
    );
  } catch (error) {
    if (error instanceof Error && /CHECK constraint failed/.test(error.message))
      throw new Error(quotaMessage);
    throw error;
  }
}
export async function insertWorkspace(owner: string, expiresAt: number) {
  await db()
    .prepare("INSERT INTO research_workspaces (id,expires_at) VALUES (?,?)")
    .bind(owner, expiresAt)
    .run();
}
export async function clearWorkspace(owner: string) {
  // Revocation and data deletion are one transaction; stale browser requests
  // cannot re-create data in the cleared workspace.
  await db().batch([
    db().prepare("DELETE FROM research_workspaces WHERE id=?").bind(owner),
    db().prepare("DELETE FROM research_checkpoints WHERE owner=?").bind(owner),
    db().prepare("DELETE FROM research_runs WHERE owner=?").bind(owner),
    db().prepare("DELETE FROM research_memories WHERE owner=?").bind(owner),
  ]);
}
export async function listRuns(owner: string) {
  const r = await db()
    .prepare(
      "SELECT id,state,updated_at FROM research_runs WHERE owner=? ORDER BY updated_at DESC LIMIT 50",
    )
    .bind(owner)
    .all<{ id: string; state: string }>();
  return r.results.map((row) => {
    const s = JSON.parse(row.state) as Run;
    return {
      id: s.id,
      goal: s.goal,
      status: s.status,
      mode: s.mode,
      updatedAt: s.updatedAt,
      stepCount: s.steps.length,
      completed: s.steps.filter((t) => t.status === "succeeded").length,
    };
  });
}
export async function getRun(owner: string, id: string) {
  const row = await db()
    .prepare(
      "SELECT state,lease_until FROM research_runs WHERE id=? AND owner=?",
    )
    .bind(id, owner)
    .first<{ state: string; lease_until: number }>();
  if (!row) throw new Error("研究不存在或无权访问");
  return {
    run: JSON.parse(row.state) as Run,
    busy: row.lease_until > Date.now(),
  };
}
export async function insertRun(owner: string, run: Run) {
  const result = await db()
    .prepare(
      "INSERT INTO research_runs (id,owner,state,created_at,updated_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM research_workspaces WHERE id=? AND expires_at>?) AND (SELECT COUNT(*) FROM research_runs WHERE owner=?) < 50",
    )
    .bind(
      run.id,
      owner,
      JSON.stringify(run),
      run.createdAt,
      run.updatedAt,
      owner,
      Date.now(),
      owner,
    )
    .run();
  if (!result.meta.changes)
    throw new Error(
      "工作台已失效或达到50条研究上限，请导出需要的报告后清空工作台。",
    );
}
export async function withRunLock(
  owner: string,
  id: string,
  fn: (run: Run, onProgress: (run: Run) => Promise<void>) => Promise<Run> | Run,
) {
  const lease = uid("lease");
  const taken = await db()
    .prepare(
      "UPDATE research_runs SET lease_id=?,lease_until=?,version=version+1 WHERE id=? AND owner=? AND lease_until < ?",
    )
    .bind(lease, Date.now() + 90000, id, owner, Date.now())
    .run();
  if (!taken.meta.changes) throw new Error("BUSY:研究正在执行，请稍后刷新");
  const flush = async (run: Run) => {
    const result = await db()
      .prepare(
        "UPDATE research_runs SET state=?,updated_at=? WHERE id=? AND owner=? AND lease_id=? AND stop_requested=0",
      )
      .bind(JSON.stringify(run), now(), id, owner, lease)
      .run();
    if (!result.meta.changes) {
      const stopped = await db()
        .prepare(
          "SELECT stop_requested FROM research_runs WHERE id=? AND owner=? AND lease_id=?",
        )
        .bind(id, owner, lease)
        .first<{ stop_requested: number }>();
      if (stopped?.stop_requested) throw new StopError();
      throw new Error("执行租约已失效");
    }
  };
  try {
    const { run } = await getRun(owner, id);
    for (const step of run.steps.filter((s) => s.status === "running")) {
      step.status = "pending";
      event(
        run,
        "recovery",
        "恢复中断步骤",
        `${step.title}：上次请求未提交最终结果；已计入的尝试额度保留，只读调用可能重试。`,
      );
    }
    const updated = await fn(run, flush);
    const stop = await db()
      .prepare(
        "SELECT stop_requested FROM research_runs WHERE id=? AND owner=? AND lease_id=?",
      )
      .bind(id, owner, lease)
      .first<{ stop_requested: number }>();
    if (!stop) throw new Error("执行租约已失效，结果未覆盖新状态");
    if (
      stop.stop_requested &&
      ["running", "planning", "ready", "waiting_approval"].includes(
        updated.status,
      )
    ) {
      updated.status = "paused";
      updated.pauseReason = "用户暂停";
      event(updated, "paused", "当前调用结果已保存，研究暂停");
      checkpoint(updated);
    }
    const state = JSON.stringify(updated);
    await db().batch([
      db()
        .prepare(
          "UPDATE research_runs SET state=CASE WHEN stop_requested=1 AND json_extract(?, '$.status') IN ('running','planning','ready','waiting_approval') THEN json_set(?, '$.status','paused','$.pauseReason','用户暂停') ELSE ? END,updated_at=?,stop_requested=0 WHERE id=? AND owner=? AND lease_id=?",
        )
        .bind(state, state, state, updated.updatedAt, id, owner, lease),
      db()
        .prepare(
          "INSERT INTO research_checkpoints (id,run_id,owner,revision,state,created_at) SELECT ?,id,owner,?,json_object('checkpoint',json_extract(state,'$.checkpoint'),'status',json_extract(state,'$.status'),'usage',json_extract(state,'$.usage'),'context',json_extract(state,'$.context'),'steps',json_extract(state,'$.steps')),? FROM research_runs WHERE id=? AND owner=? AND lease_id=?",
        )
        .bind(uid("cp"), updated.checkpoint.revision, now(), id, owner, lease),
    ]);
    return (await getRun(owner, id)).run;
  } finally {
    await db()
      .prepare(
        "UPDATE research_runs SET lease_id=NULL,lease_until=0 WHERE id=? AND owner=? AND lease_id=?",
      )
      .bind(id, owner, lease)
      .run();
  }
}
export async function requestStop(owner: string, id: string) {
  const result = await db()
    .prepare(
      "UPDATE research_runs SET stop_requested=1 WHERE id=? AND owner=? AND lease_until>=?",
    )
    .bind(id, owner, Date.now())
    .run();
  return !!result.meta.changes;
}
export async function listMemories(owner: string): Promise<Memory[]> {
  const result = await db()
    .prepare(
      "SELECT id,content,source_run_id,created_at FROM research_memories WHERE owner=? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(owner)
    .all<{
      id: string;
      content: string;
      source_run_id: string | null;
      created_at: string;
    }>();
  return result.results.map((r) => ({
    id: r.id,
    text: r.content,
    createdAt: r.created_at,
    sourceRunId: r.source_run_id ?? undefined,
  }));
}
export async function addMemory(
  owner: string,
  text: string,
  sourceRunId?: string,
) {
  if ((await listMemories(owner)).length >= 20)
    throw new Error("最多保存20条偏好，请先删除不再使用的内容");
  const memory = { id: uid("mem"), text, createdAt: now(), sourceRunId };
  const result = await db()
    .prepare(
      "INSERT INTO research_memories (id,owner,content,source_run_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM research_workspaces WHERE id=? AND expires_at>?) AND (SELECT COUNT(*) FROM research_memories WHERE owner=?) < 20",
    )
    .bind(
      memory.id,
      owner,
      text,
      sourceRunId ?? null,
      memory.createdAt,
      owner,
      Date.now(),
      owner,
    )
    .run();
  if (!result.meta.changes)
    throw new Error("工作台已失效或偏好达到20条上限，请刷新后重试。");
  return memory;
}
export async function deleteMemory(owner: string, id: string) {
  await db()
    .prepare("DELETE FROM research_memories WHERE owner=? AND id=?")
    .bind(owner, id)
    .run();
}

export async function getServiceConnection<T>(
  id: string,
  credentialHash: string,
): Promise<T | null> {
  const row = await db()
    .prepare(
      "SELECT state FROM service_connections WHERE id=? AND credential_hash=?",
    )
    .bind(id, credentialHash)
    .first<{ state: string }>();
  return row ? (JSON.parse(row.state) as T) : null;
}
export async function saveServiceConnection(
  id: string,
  credentialHash: string,
  state: unknown,
) {
  await db()
    .prepare(
      "INSERT INTO service_connections (id,credential_hash,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash,state=excluded.state",
    )
    .bind(id, credentialHash, JSON.stringify(state))
    .run();
}
