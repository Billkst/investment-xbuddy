import { advanceRun, applyAction, defaultConfig } from "./engine.ts";
import { createRun, event, type Run } from "./types.ts";

export const GUEST_STORAGE_KEY = "xbuddy-guest-v1";
const MAX_RUNS = 10;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Only constructed data runs live here. Personal research continues through
// the authenticated API; guest input never enters the server-side store.
export class GuestWorkspace {
  private pending: Promise<unknown> = Promise.resolve();
  private storage: StoragePort;
  constructor(storage: StoragePort) {
    this.storage = storage;
  }

  private read(): Run[] {
    let raw: string | null;
    try {
      raw = this.storage.getItem(GUEST_STORAGE_KEY);
    } catch {
      throw new Error("浏览器禁止临时存储，请允许本站存储后重试。");
    }
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value) || value.length > MAX_RUNS) throw new Error();
      for (const run of value) {
        if (
          !run ||
          run.mode !== "demo" ||
          !/^run_[a-f0-9]{16}$/.test(run.id) ||
          typeof run.goal !== "string" ||
          !Array.isArray(run.steps) ||
          !Array.isArray(run.evidence) ||
          !Array.isArray(run.events) ||
          !run.budget ||
          !run.usage ||
          !run.context ||
          !run.checkpoint
        )
          throw new Error();
      }
      return value as Run[];
    } catch {
      throw new Error("临时研究记录无法读取，请点击“清除临时记录”后重新体验。");
    }
  }

  private write(runs: Run[]) {
    try {
      this.storage.setItem(GUEST_STORAGE_KEY, JSON.stringify(runs));
    } catch {
      throw new Error(
        "临时存储空间不足或不可用，已有记录仍保留。请先导出报告，再清除临时记录。",
      );
    }
  }

  listRuns() {
    return this.read().map((run) => ({
      id: run.id,
      goal: run.goal,
      status: run.status,
      mode: run.mode,
      updatedAt: run.updatedAt,
      stepCount: run.steps.length,
      completed: run.steps.filter((step) => step.status === "succeeded").length,
    }));
  }

  request(
    body?: Record<string, unknown>,
    id?: string,
  ): Promise<{ run: Run } | { ok: true }> {
    // Reads return fresh objects and mutations are serialized, so a pause or
    // approval cannot overwrite a just-finished step with an older snapshot.
    const next = this.pending.then(() => this.perform(body, id));
    this.pending = next.catch(() => {});
    return next;
  }

  private async perform(body?: Record<string, unknown>, id?: string) {
    if (body?.action === "guest_clear") {
      this.storage.removeItem(GUEST_STORAGE_KEY);
      return { ok: true as const };
    }
    if (String(body?.action ?? "").startsWith("memory_"))
      throw new Error("长期研究记忆需要登录后使用。");
    const runs = this.read();
    if (body?.action === "create") {
      if (body.mode !== "demo")
        throw new Error("免登录体验使用构造数据；真实数据研究请先登录。");
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      const maxCalls = Number(body.maxCalls ?? 10);
      const fault = (body.fault ?? "none") as Run["fault"];
      if (goal.length < 4 || goal.length > 2000)
        throw new Error("研究目标需为4至2000字");
      if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 30)
        throw new Error("调用预算需为1至30的整数");
      if (
        !["none", "tool_failure", "missing_data", "model_failure"].includes(
          fault,
        )
      )
        throw new Error("无效的故障演练类型");
      if (runs.length >= MAX_RUNS)
        throw new Error(
          "临时体验最多保留10个研究，请导出需要的报告后清除临时记录。",
        );
      const run = createRun(goal, "demo", [], { maxCalls, fault });
      event(
        run,
        "guest",
        "免登录临时体验",
        "规则规划与构造数据在浏览器中运行，记录仅保存在当前标签页，不同步到个人账号。",
      );
      this.write([run, ...runs]);
      return { run };
    }
    const run = runs.find((item) => item.id === (id ?? String(body?.id ?? "")));
    if (!run)
      throw new Error(
        "当前标签页中没有这条临时研究，请新建研究或登录个人空间。",
      );
    if (!body) return { run };
    // Never accept configuration or mode from restored data or action input.
    if (run.mode !== "demo") throw new Error("临时体验仅支持构造数据。");
    run.memoryContext = [];
    if (body.action === "advance") await advanceRun(run, { ...defaultConfig });
    else applyAction(run, String(body.action), body);
    this.write([run, ...runs.filter((item) => item.id !== run.id)]);
    return { run };
  }
}
