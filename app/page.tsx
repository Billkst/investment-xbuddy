"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Plus,
  Sparkles,
  Activity,
  BookOpen,
  ShieldCheck,
  FlaskConical,
  Layers,
  ChevronRight,
  Check,
  Clock,
  Pause,
  Play,
  RotateCcw,
  FileText,
  ExternalLink,
  Database,
  AlertTriangle,
  Search,
  Download,
  Trash2,
  Settings2,
  Compass,
  Link2,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  BrainCircuit,
  Command,
  Radio,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster, toast } from "sonner";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type {
  Run,
  Evidence,
  Memory,
  Mode,
  RunStatus,
  ResearchEvent,
} from "@/lib/research/types";
import { toolRegistry } from "@/lib/research/tools";

type Brief = {
  id: string;
  goal: string;
  status: RunStatus;
  mode: Mode;
  updatedAt: string;
  stepCount: number;
  completed: number;
};
type Bootstrap = {
  access: "anonymous";
  runs: Brief[];
  memories: Memory[];
  config: {
    model: boolean;
    modelName: string | null;
    fuyao: boolean;
    publicMarket: boolean;
    contextLimit: number;
  };
  tools: typeof toolRegistry;
};
const statusText: Record<RunStatus, string> = {
  planning: "规划中",
  needs_input: "待补充信息",
  ready: "计划已就绪",
  running: "研究进行中",
  paused: "已暂停",
  waiting_approval: "待确认",
  completed: "研究已完成",
  failed: "执行异常",
};
const samples = [
  {
    tag: "行情与风险",
    title: "把价格变化，拆成可验证的问题",
    text: "分析贵州茅台近一年的价格走势、波动与最大回撤，说明数据局限。",
    mode: "live" as Mode,
    icon: Activity,
  },
  {
    tag: "指数观察",
    title: "看清一段行情的风险轮廓",
    text: "研究沪深300近三个月的走势和最大回撤，给出简短研究摘要。",
    mode: "live" as Mode,
    icon: Compass,
  },
  {
    tag: "完整流程 · 构造数据",
    title: "比较公司的现金流与盈利质量",
    text: "比较贵州茅台和五粮液最近三年的盈利质量与估值，重点关注现金流。",
    mode: "demo" as Mode,
    icon: Layers,
  },
];
function dateLabel(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function valueLabel(e: Evidence) {
  if (e.value === null) return "—";
  if (Math.abs(e.value) >= 1e8) return `${(e.value / 1e8).toFixed(2)} 亿`;
  return e.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
async function serverApi<
  T = { run: Run; busy?: boolean; stopRequested?: boolean },
>(body?: Record<string, unknown>, id?: string) {
  const response = await fetch(
    `/api/research${id ? `?id=${encodeURIComponent(id)}` : ""}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw Object.assign(new Error(data.error ?? "请求失败"), {
      status: response.status,
    });
  return data;
}
let bootstrapRequest: Promise<Bootstrap> | null = null;
async function api<T = { run: Run; busy?: boolean; stopRequested?: boolean }>(
  body?: Record<string, unknown>,
  id?: string,
): Promise<T> {
  // Coalesce initial reads so React effects cannot create competing cookies.
  if (!body && !id) {
    if (!bootstrapRequest)
      bootstrapRequest = serverApi<Bootstrap>().finally(() => {
        bootstrapRequest = null;
      });
    return (await bootstrapRequest) as T;
  }
  return serverApi<T>(body, id);
}
export default function Home() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [goal, setGoal] = useState(""),
    [mode, setMode] = useState<Mode>("demo"),
    [budget, setBudget] = useState("10"),
    [fault, setFault] = useState<Run["fault"]>("none"),
    [run, setRun] = useState<Run | null>(null),
    [view, setView] = useState<"research" | "memory" | "tools">("research"),
    [tab, setTab] = useState("plan"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null),
    [memoryText, setMemoryText] = useState(""),
    [clarification, setClarification] = useState(""),
    [stopRequested, setStopRequested] = useState(false);
  const runRef = useRef(run);
  runRef.current = run;
  const advancing = useRef<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const data = await api<Bootstrap>();
    setBoot(data);
    return data as Bootstrap;
  }, []);
  useEffect(() => {
    refresh()
      .then(async (data) => {
        const id = new URLSearchParams(window.location.search).get("run");
        if (id) {
          const saved = await api(undefined, id);
          setRun(saved.run);
          setTab(saved.run.report ? "report" : "plan");
        }
      })
      .catch((e) => setError(e.message));
    try {
      const draft = sessionStorage.getItem("xbuddy-draft");
      if (draft) setGoal(draft);
    } catch {
      /* Optional draft storage must not prevent server-backed research. */
    }
  }, [refresh]);
  useEffect(() => {
    try {
      sessionStorage.setItem("xbuddy-draft", goal);
    } catch {
      /* Keep the editable input even when draft storage is unavailable. */
    }
  }, [goal]);
  const showRun = useCallback((next: Run) => {
    setRun(next);
    window.history.replaceState(null, "", `/?run=${next.id}`);
    setBoot((previous) =>
      previous
        ? {
            ...previous,
            runs: [
              {
                id: next.id,
                goal: next.goal,
                status: next.status,
                mode: next.mode,
                updatedAt: next.updatedAt,
                stepCount: next.steps.length,
                completed: next.steps.filter((s) => s.status === "succeeded")
                  .length,
              },
              ...previous.runs.filter((r) => r.id !== next.id),
            ],
          }
        : previous,
    );
  }, []);
  useEffect(() => {
    if (!run || !["planning", "running"].includes(run.status) || stopRequested)
      return;
    const id = run.id;
    const token = generation.current;
    let disposed = false;
    const timer = setTimeout(async () => {
      if (advancing.current === id) return;
      advancing.current = id;
      try {
        const data = await api({ action: "advance", id });
        if (!disposed && generation.current === token) {
          showRun(data.run);
          if (data.run.status === "completed") setTab("report");
        }
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 409) {
          try {
            const data = await api(undefined, id);
            if (!disposed && generation.current === token) showRun(data.run);
          } catch (inner) {
            if (!disposed) setError((inner as Error).message);
          }
        } else if (!disposed) {
          setError(err.message);
          setStopRequested(true);
        }
      } finally {
        if (advancing.current === id) advancing.current = null;
      }
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [run, stopRequested, showRun]);
  const create = useCallback(
    async (input?: string, inputMode?: Mode) => {
      const text = (input ?? goal).trim();
      if (text.length < 4) {
        toast.error("请描述至少4个字的研究目标");
        return;
      }
      if (!boot) return;
      generation.current++;
      setBusy(true);
      setError("");
      setStopRequested(false);
      try {
        const data = await api({
          action: "create",
          goal: text,
          mode: inputMode ?? mode,
          maxCalls: Number(budget),
          fault,
        });
        showRun(data.run);
        setView("research");
        setTab("plan");
        return { id: data.run.id, status: data.run.status };
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [goal, mode, budget, fault, boot, showRun],
  );
  const action = async (
    name: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const data = await api({ action: name, id: run.id, ...payload });
      if (data.stopRequested) {
        setStopRequested(true);
        toast("暂停请求已保存，正在等待当前调用结束");
        const id = run.id;
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const state = await api(undefined, id);
          if (runRef.current?.id !== id) break;
          showRun(state.run);
          if (!state.busy) {
            setStopRequested(false);
            break;
          }
        }
      } else {
        showRun(data.run);
        setStopRequested(false);
      }
      if (name === "compress") toast.success("摘要已保存，原始证据完整保留");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openRun = async (id: string) => {
    generation.current++;
    setBusy(true);
    setError("");
    setStopRequested(false);
    try {
      const data = await api(undefined, id);
      showRun(data.run);
      setView("research");
      setTab(data.run.report ? "report" : "plan");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const newResearch = () => {
    window.history.replaceState(null, "", "/");
    generation.current++;
    setRun(null);
    setView("research");
    setError("");
    setStopRequested(false);
    setGoal("");
  };
  const clearWorkspace = async () => {
    if (
      !window.confirm(
        "将删除当前工作台的全部研究记录与研究记忆。请先导出需要的报告，确定清空吗？",
      )
    )
      return;
    generation.current++;
    setBusy(true);
    try {
      await api({ action: "workspace_clear" });
      try {
        sessionStorage.removeItem("xbuddy-draft");
      } catch {}
      newResearch();
      setSelectedEvidence(null);
      await refresh();
      toast.success("记录与记忆已清空，新的免登录工作台已就绪");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveMemory = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api({ action: "memory_add", text: memoryText });
      setMemoryText("");
      await refresh();
      toast.success("研究偏好已保存，将用于下一次规划");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeMemory = async (id: string) => {
    try {
      await api({ action: "memory_delete", memoryId: id });
      await refresh();
      toast.success("已删除偏好");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: { signal: AbortSignal },
          ) => unknown;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      Promise.resolve(
        context.registerTool(
          {
            name: "create_research",
            title: "创建投资研究",
            description:
              "根据研究目标创建并保存一个研究线程，开始生成计划；不会自动批准预算扩展。",
            inputSchema: {
              type: "object",
              properties: {
                goal: { type: "string", minLength: 4, maxLength: 2000 },
                mode: { type: "string", enum: ["live", "demo"] },
              },
              required: ["goal", "mode"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute: async (input: unknown) => {
              const x = input as { goal?: unknown; mode?: unknown };
              if (
                typeof x.goal !== "string" ||
                x.goal.length < 4 ||
                x.goal.length > 2000 ||
                !["live", "demo"].includes(String(x.mode))
              )
                throw new Error("研究目标或数据模式无效");
              return await createRef.current(x.goal, x.mode as Mode);
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => lifecycle.abort();
  }, []);
  const download = () => {
    if (!run?.report) return;
    const r = run.report;
    const text = [
      `# ${r.title}`,
      `\n数据模式：${run.mode === "demo" ? "构造数据演示" : "真实数据"}；规划：${run.planner === "model" ? "模型" : "规则降级"}`,
      `\n研究目标：${run.goal}`,
      `\n${r.summary}`,
      "\n## 研究发现",
      ...r.findings.map(
        (f) =>
          `\n- **${f.kind === "fact" ? "事实" : f.kind === "inference" ? "推断" : "不确定"}** ${f.text} ${f.evidenceIds.map((id) => `[${id}]`).join(" ")}`,
      ),
      "\n## 限制与数据缺口",
      ...r.gaps.map((g) => `- ${g}`),
      "\n## 证据",
      ...run.evidence.map(
        (e) =>
          `\n### ${e.id}\n${e.security.name} · ${e.label}: ${e.value ?? "缺失"} ${e.unit}\n来源：${e.source}\n数据时点：${e.asOf}\n获取时间：${e.retrievedAt}\n口径：${e.basis}\n字段：${e.field}\n链接：${e.sourceUrl || "本地计算/构造数据"}\n${e.formula ? `公式：${e.formula}\n输入证据：${e.inputIds?.join(", ")}` : ""}\n\`\`\`json\n${JSON.stringify(e.raw, null, 2)}\n\`\`\``,
      ),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `XBuddy-${run.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const finished =
    run?.steps.filter((s) =>
      ["succeeded", "failed", "skipped"].includes(s.status),
    ).length ?? 0;
  return (
    <SidebarProvider>
      <Toaster position="top-center" richColors />
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <button className="brand" onClick={newResearch}>
            <span className="brand-symbol">X</span>
            <div>
              投资 XBuddy<small>PERSONAL RESEARCH DESK</small>
            </div>
          </button>
          <Button className="new-research" onClick={newResearch}>
            <Plus size={17} />
            新建研究
          </Button>
        </SidebarHeader>
        <SidebarContent>
          <p className="nav-label">我的工作台</p>
          {(
            [
              { id: "research", label: "研究空间", icon: Activity },
              { id: "memory", label: "研究记忆", icon: BookOpen },
              { id: "tools", label: "能力与连接", icon: Layers },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={`nav-item ${view === n.id ? "active" : ""}`}
              onClick={() => setView(n.id)}
            >
              <n.icon size={17} />
              {n.label}
              {n.id === "memory" && !!boot?.memories.length && (
                <span className="nav-count">{boot.memories.length}</span>
              )}
            </button>
          ))}
          <div className="history-label">
            <p className="nav-label">研究线程</p>
            <span>{boot?.runs.length ?? 0}</span>
          </div>
          {!boot && !error ? (
            <div className="px-6 space-y-3">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-4/5" />
            </div>
          ) : !boot?.runs.length ? (
            <p className="sidebar-hint">从第一个研究问题开始</p>
          ) : (
            boot.runs.map((r) => (
              <button
                key={r.id}
                className={`history-item ${run?.id === r.id && view === "research" ? "selected" : ""}`}
                onClick={() => openRun(r.id)}
              >
                <div>
                  <FileText size={14} />
                  <span>{r.goal}</span>
                </div>
                <small>
                  <span className={`tiny-status ${r.status}`} />
                  {statusText[r.status]}
                  <span>{dateLabel(r.updatedAt)}</span>
                </small>
              </button>
            ))
          )}
        </SidebarContent>
        <SidebarFooter>
          <div className="sidebar-foot">
            <ShieldCheck size={17} />
            每个判断，都有据可查
          </div>
          <div className="profile">
            <div className="avatar">研</div>
            <div>
              免登录研究工作台
              <small>本浏览器的记录与偏好自动保存</small>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main className="workspace" aria-busy={!boot}>
        <header className="topbar">
          <div className="topbar-title">
            <SidebarTrigger className="md:hidden" />
            <span>我的工作台</span>
            <ChevronRight size={14} />
            <strong>
              {view === "memory"
                ? "研究记忆"
                : view === "tools"
                  ? "能力与连接"
                  : "研究空间"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="private-label">
              <ShieldCheck size={14} />
              免登录使用
            </span>
            <span className="mode-pill neutral">
              <BrainCircuit size={13} />
              {boot?.config.model ? "AI 模型已配置" : "AI 未接入 · 规则运行"}
            </span>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError("");
                setStopRequested(false);
                if (run) openRun(run.id);
                else refresh().catch((e) => setError(e.message));
              }}
            >
              重试
            </Button>
          </div>
        )}
        {boot && (
          <div className="workspace-notice">
            <Database size={19} />
            <div>
              <strong>打开即用，研究记录与记忆自动保存</strong>
              <p>
                同一浏览器再次打开可继续研究。更换设备或清除本站 Cookie
                后无法恢复原工作台，请导出需要的报告。
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                busy || (!!run && ["planning", "running"].includes(run.status))
              }
              onClick={clearWorkspace}
            >
              <Trash2 size={14} />
              清空工作台
            </Button>
          </div>
        )}
        {view === "research" && !run && (
          <section className="welcome">
            <div className="eyebrow">
              <span />
              从一个好问题开始
            </div>
            <h1>今天，想研究什么？</h1>
            <p className="welcome-intro">
              描述你的目标，让研究有计划、有证据、有后续。
            </p>
            <form
              className="goal-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void create().catch(() => {});
              }}
            >
              <Textarea
                aria-label="研究目标"
                value={goal}
                maxLength={2000}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="输入研究目标、关注的标的或想验证的判断…"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void create().catch(() => {});
                  }
                }}
              />
              <div className="composer-footer">
                <div className="composer-options">
                  <Select
                    value={mode}
                    onValueChange={(v) => setMode(v as Mode)}
                  >
                    <SelectTrigger
                      aria-label="数据模式"
                      className="mode-select"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="live">真实数据</SelectItem>
                      <SelectItem value="demo">构造数据演示</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="shortcut">
                    <Command size={11} />
                    Enter
                  </span>
                </div>
                <Button
                  type="submit"
                  disabled={busy || !boot || !goal.trim()}
                  className="create-button"
                >
                  {busy ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  生成研究计划
                </Button>
              </div>
            </form>
            <div className="scope-note">
              {mode === "demo" ? (
                <FlaskConical size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              <span>
                {mode === "demo"
                  ? `演示数值均为构造数据，不代表真实证券。${boot?.config.model ? "规划可使用已配置模型。" : "当前未接入 AI，计划由规则生成。"}`
                  : `行情优先使用扶摇，未配置时使用腾讯公开行情。${boot?.config.model ? "" : "当前模型未配置，将使用规则规划降级。"}`}
              </span>
            </div>
            <details className="advanced-options">
              <summary>
                <Settings2 size={14} />
                执行与验证选项
                <ChevronDown size={13} />
              </summary>
              <div className="options-grid">
                <label>
                  调用额度
                  <Select value={budget} onValueChange={setBudget}>
                    <SelectTrigger aria-label="调用额度">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 4, 10, 20, 30].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} 次
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label>
                  故障演练
                  <Select
                    value={fault}
                    onValueChange={(v) => setFault(v as Run["fault"])}
                  >
                    <SelectTrigger aria-label="故障演练">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">关闭</SelectItem>
                      <SelectItem value="tool_failure">工具超时一次</SelectItem>
                      <SelectItem value="missing_data">字段缺失一次</SelectItem>
                      <SelectItem value="model_failure">模型不可用</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            </details>
            <div className="section-caption">
              <span>也可以从这些问题开始</span>
              <span>可编辑的研究示例</span>
            </div>
            <div className="sample-grid">
              {samples.map((s) => (
                <button
                  key={s.tag}
                  className="sample-card"
                  onClick={() => {
                    setGoal(s.text);
                    setMode(s.mode);
                  }}
                >
                  <span className="sample-icon">
                    <s.icon size={19} />
                  </span>
                  <span className="sample-tag">{s.tag}</span>
                  <strong>{s.title}</strong>
                  <p>{s.text}</p>
                </button>
              ))}
            </div>
            <div className="research-path">
              {["明确目标", "规划任务", "核验证据", "沉淀成果"].map((s, i) => (
                <div key={s}>
                  <span>0{i + 1}</span>
                  {s}
                  {i < 3 && <span className="path-line" />}
                </div>
              ))}
            </div>
          </section>
        )}
        {view === "research" && run && (
          <section className="run-workspace">
            <div className="run-heading">
              <div>
                <div className="eyebrow">
                  RESEARCH / {run.id.slice(-6).toUpperCase()}
                </div>
                <h1>
                  {run.intent?.securities.length
                    ? run.intent.securities.map((s) => s.name).join(" × ")
                    : "正在理解研究目标"}
                </h1>
                <p className="run-goal">{run.goal}</p>
              </div>
              <div className="run-heading-actions">
                <span className={`status-badge ${run.status}`}>
                  {["planning", "running"].includes(run.status) ? (
                    <Loader2 className="spin" size={13} />
                  ) : run.status === "completed" ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <Clock size={13} />
                  )}{" "}
                  {statusText[run.status]}
                </span>
                {run.report && (
                  <Button size="sm" variant="outline" onClick={download}>
                    <Download size={14} />
                    导出报告
                  </Button>
                )}
              </div>
            </div>
            <div className="run-badges">
              <span
                className={`mode-pill ${run.mode === "live" ? "neutral" : ""}`}
              >
                {run.mode === "demo" ? (
                  <FlaskConical size={13} />
                ) : (
                  <Database size={13} />
                )}{" "}
                {run.mode === "demo" ? "构造数据演示" : "真实数据研究"}
              </span>
              <span className="muted-tag">
                <BrainCircuit size={13} />
                {run.planner === "pending"
                  ? "规划中"
                  : run.planner === "model"
                    ? "模型规划"
                    : "规则规划 · 无模型参与"}
              </span>
              {run.intent && (
                <span className="muted-tag">
                  <Clock size={13} />
                  {run.intent.start} — {run.intent.end}
                </span>
              )}
            </div>
            {(run.mode === "demo" || run.planner === "rules") && (
              <div className="inline-note">
                <AlertTriangle size={14} />
                {run.mode === "demo"
                  ? "本研究全部金融数值为构造数据，仅验证流程。 "
                  : ""}
                {run.planner === "rules"
                  ? "模型未参与规划；当前按已识别标的与研究重点生成有限范围的任务。"
                  : ""}
              </div>
            )}
            <div className="run-stats">
              <div>
                <span>任务进度</span>
                <strong>
                  {finished}
                  <small> / {run.steps.length}</small>
                </strong>
                <Progress
                  value={
                    run.steps.length ? (finished / run.steps.length) * 100 : 0
                  }
                  className="h-1.5"
                />
              </div>
              <div>
                <span>已保存证据</span>
                <strong>
                  {run.evidence.length}
                  <small> 条</small>
                </strong>
                <p>原始字段与计算依据</p>
              </div>
              <div>
                <span>调用额度</span>
                <strong>
                  {run.usage.calls}
                  <small> / {run.budget.maxCalls}</small>
                </strong>
                <p>
                  {run.mode === "demo"
                    ? "含模拟调用；不产生数据费用"
                    : "含模型与数据请求尝试"}
                </p>
              </div>
              <div>
                <span>累计执行耗时</span>
                <strong>
                  {(run.usage.durationMs / 1000).toFixed(1)}
                  <small> 秒</small>
                </strong>
                <p>{run.usage.tokens.toLocaleString()} tokens · 费用未计价</p>
              </div>
            </div>
            {run.approval && (
              <div className="approval-card">
                <div className="approval-icon">
                  <ShieldCheck size={23} />
                </div>
                <div>
                  <h3>
                    {run.approval.kind === "budget"
                      ? "继续研究前，确认调用额度"
                      : "确认扩展研究范围"}
                  </h3>
                  <p>{run.approval.reason}</p>
                  <small>只有批准此项请求后，相关调用才会继续。</small>
                </div>
                <div className="approval-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      action("reject", { approvalId: run.approval!.id })
                    }
                  >
                    拒绝
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action("approve", { approvalId: run.approval!.id })
                    }
                  >
                    批准并继续
                  </Button>
                </div>
              </div>
            )}
            {run.status === "needs_input" && (
              <form
                className="clarification-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  action("clarify", { text: clarification });
                }}
              >
                <h3>
                  <Search size={17} />
                  还需要一点信息
                </h3>
                <p>{run.intent?.clarification}</p>
                <div>
                  <Input
                    aria-label="补充研究信息"
                    value={clarification}
                    onChange={(e) => setClarification(e.target.value)}
                    placeholder="补充证券代码、时间范围或研究重点"
                  />
                  <Button disabled={busy || !clarification.trim()}>
                    补充并规划
                  </Button>
                </div>
              </form>
            )}
            <div className="run-columns">
              <div className="run-main">
                <Tabs value={tab} onValueChange={setTab}>
                  <div className="tabs-toolbar">
                    <TabsList variant="line">
                      <TabsTrigger value="plan">
                        <Layers size={15} />
                        研究计划
                      </TabsTrigger>
                      <TabsTrigger value="report">
                        <FileText size={15} />
                        研究成果
                        {run.report && <span className="tab-count">1</span>}
                      </TabsTrigger>
                      <TabsTrigger value="events">
                        <Activity size={15} />
                        运行记录
                      </TabsTrigger>
                    </TabsList>
                    <div className="execution-buttons">
                      {run.status === "ready" && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => action("start")}
                        >
                          <Play size={13} />
                          执行计划
                        </Button>
                      )}
                      {["running", "planning"].includes(run.status) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={stopRequested}
                          onClick={() => action("pause")}
                        >
                          <Pause size={13} />
                          {stopRequested ? "正在暂停" : "暂停"}
                        </Button>
                      )}
                      {["paused", "failed"].includes(run.status) &&
                        !run.approval && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => action("resume")}
                          >
                            <Play size={13} />
                            继续执行
                          </Button>
                        )}
                    </div>
                  </div>
                  <TabsContent value="plan">
                    <div className="plan-card">
                      <div className="card-heading">
                        <div>
                          <h2>研究路径</h2>
                          <p>
                            {run.intent?.focus.join(" · ") ||
                              "正在识别研究范围与数据需求"}
                          </p>
                        </div>
                        <span className="muted-tag">
                          {run.steps.length} 个步骤
                        </span>
                      </div>
                      {!run.steps.length ? (
                        <div className="empty-panel">
                          <BrainCircuit size={30} />
                          <p>
                            {run.status === "needs_input"
                              ? "补充信息后，将生成可执行的研究计划。"
                              : "正在识别研究目标、可用工具与约束…"}
                          </p>
                        </div>
                      ) : (
                        <ol className="step-list">
                          {run.steps.map((s, i) => (
                            <li key={s.id} className={`step ${s.status}`}>
                              <div className="step-marker">
                                {s.status === "succeeded" ? (
                                  <Check size={15} />
                                ) : s.status === "failed" ? (
                                  <XCircle size={15} />
                                ) : s.status === "running" ? (
                                  <Loader2 size={15} className="spin" />
                                ) : (
                                  <span>{String(i + 1).padStart(2, "0")}</span>
                                )}
                              </div>
                              <div className="step-body">
                                <div className="step-title">
                                  <strong>{s.title}</strong>
                                  <span>
                                    {s.status === "succeeded"
                                      ? "已完成"
                                      : s.status === "failed"
                                        ? "失败"
                                        : s.status === "skipped"
                                          ? "已跳过"
                                          : s.status === "running"
                                            ? "执行中"
                                            : "待执行"}
                                  </span>
                                </div>
                                <p>{toolRegistry[s.tool]?.description}</p>
                                <div className="step-meta">
                                  <code>{s.tool}</code>
                                  {s.evidenceIds.length > 0 && (
                                    <span>{s.evidenceIds.length} 条证据</span>
                                  )}
                                  {s.durationMs !== undefined && (
                                    <span>
                                      {(s.durationMs / 1000).toFixed(2)}s
                                    </span>
                                  )}
                                </div>
                                {s.error && (
                                  <div className="step-error">
                                    {s.error}
                                    {s.status === "failed" && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={
                                          busy ||
                                          ["planning", "running"].includes(
                                            run.status,
                                          )
                                        }
                                        onClick={() =>
                                          action("retry", { stepId: s.id })
                                        }
                                      >
                                        <RotateCcw size={12} />
                                        重试
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                      {run.intent?.limitations.map((text, i) => (
                        <p className="plan-limitation" key={i}>
                          <AlertTriangle size={13} />
                          {text}
                        </p>
                      ))}
                    </div>
                    {["paused", "waiting_approval", "failed"].includes(
                      run.status,
                    ) && (
                      <div className="partial-action">
                        <p>
                          {run.pauseReason ??
                            "你也可以使用当前已有证据完成研究。"}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => action("partial")}
                        >
                          生成部分报告
                        </Button>
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="report">
                    {run.report ? (
                      <article className="report-card">
                        <div className="report-overline">
                          <FileText size={15} />
                          研究备忘录
                          <span>{dateLabel(run.report.createdAt)}</span>
                        </div>
                        <h2>{run.report.title}</h2>
                        <p className="report-summary">{run.report.summary}</p>
                        <PriceChart evidence={run.evidence} />
                        <h3>研究发现</h3>
                        {run.report.findings.length ? (
                          run.report.findings.map((f, i) => (
                            <div className="finding" key={i}>
                              <span className={`finding-kind ${f.kind}`}>
                                {f.kind === "fact"
                                  ? "事实"
                                  : f.kind === "inference"
                                    ? "推断"
                                    : "不确定"}
                              </span>
                              <div>
                                <p>{f.text}</p>
                                <div className="citation-list">
                                  {f.evidenceIds.map((id) => (
                                    <button
                                      key={id}
                                      onClick={() =>
                                        setSelectedEvidence(
                                          run.evidence.find(
                                            (e) => e.id === id,
                                          ) ?? null,
                                        )
                                      }
                                    >
                                      <Link2 size={11} />
                                      证据{" "}
                                      {run.evidence.findIndex(
                                        (e) => e.id === id,
                                      ) + 1}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="empty-text">
                            没有取得可核验的事实证据。
                          </p>
                        )}
                        {run.report.gaps.length > 0 && (
                          <div className="report-gaps">
                            <h3>
                              <AlertTriangle size={16} />
                              数据缺口与研究边界
                            </h3>
                            <ul>
                              {run.report.gaps.map((g, i) => (
                                <li key={i}>{g}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <h3>下一步值得追问</h3>
                        <ul className="followups">
                          {run.report.questions.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                        <div className="report-footer">
                          <ShieldCheck size={15} />
                          本报告用于研究，不提供买卖指令或收益承诺。
                        </div>
                      </article>
                    ) : (
                      <div className="empty-panel bordered">
                        <FileText size={34} />
                        <h3>研究成果将在这里汇集</h3>
                        <p>完成数据任务后，生成带证据引用的研究备忘录。</p>
                        {run.status === "ready" && (
                          <Button onClick={() => action("start")}>
                            <Play size={14} />
                            执行研究计划
                          </Button>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="events">
                    <div className="events-card">
                      <div className="card-heading">
                        <div>
                          <h2>运行记录</h2>
                          <p>实际执行事件、耗时与恢复状态</p>
                        </div>
                        <span>{run.events.length} 条</span>
                      </div>
                      <ol className="event-list">
                        {[...run.events].reverse().map((e) => (
                          <EventRow key={e.id} event={e} />
                        ))}
                      </ol>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
              <aside className="evidence-column">
                <div className="evidence-card">
                  <div className="card-heading">
                    <h2>
                      <Database size={16} />
                      证据库
                    </h2>
                    <span className="count-pill">{run.evidence.length}</span>
                  </div>
                  <p className="panel-description">
                    点击证据，查看原始字段与统计口径
                  </p>
                  {run.evidence.length ? (
                    <div className="evidence-list">
                      {run.evidence.map((e, i) => (
                        <button
                          key={e.id}
                          className="evidence-item"
                          onClick={() => setSelectedEvidence(e)}
                        >
                          <div className="evidence-item-top">
                            <span>{String(i + 1).padStart(2, "0")}</span>
                            <strong>{e.security.name}</strong>
                            <span className={`quality-label ${e.quality}`}>
                              {e.quality === "demo"
                                ? "构造"
                                : e.quality === "missing"
                                  ? "缺失"
                                  : e.quality === "stale"
                                    ? "待核对"
                                    : e.formula
                                      ? "计算"
                                      : "原始"}
                            </span>
                          </div>
                          <div className="evidence-value">
                            <span>{e.label}</span>
                            <strong>
                              {valueLabel(e)}
                              <small>{e.unit}</small>
                            </strong>
                          </div>
                          <div className="evidence-bottom">
                            <span>{e.source}</span>
                            <span>{e.asOf}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="evidence-empty">
                      <Database size={26} />
                      <p>还没有证据</p>
                      <span>工具结果会在执行后自动保存</span>
                    </div>
                  )}
                </div>
                <div className="context-card">
                  <div className="card-heading">
                    <h2>
                      <BrainCircuit size={16} />
                      研究上下文
                    </h2>
                    <span className="count-pill">{run.context.revision}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>检查点</dt>
                      <dd>第 {run.checkpoint.revision} 次</dd>
                    </div>
                    <div>
                      <dt>已保存步骤</dt>
                      <dd>{run.checkpoint.completedSteps.length} 个</dd>
                    </div>
                    <div>
                      <dt>读取长期偏好</dt>
                      <dd>{run.memoryContext.length} 条</dd>
                    </div>
                    {run.context.compressedAt && (
                      <div>
                        <dt>压缩字符数</dt>
                        <dd>
                          {run.context.beforeChars} → {run.context.afterChars}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {run.context.summary && (
                    <details>
                      <summary>查看压缩摘要</summary>
                      <pre>{run.context.summary}</pre>
                    </details>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy ||
                      ["planning", "running"].includes(run.status) ||
                      !run.evidence.length
                    }
                    onClick={() => action("compress")}
                  >
                    压缩并保存上下文
                  </Button>
                  <p>原始证据完整保留，后续模型调用读取摘要。</p>
                </div>
              </aside>
            </div>
          </section>
        )}
        {view === "memory" && (
          <section className="secondary-page">
            <div className="eyebrow">RESEARCH MEMORY</div>
            <h1>让下一次研究，更了解你</h1>
            <p className="page-intro">
              明确保存的偏好会在新研究中读取，你可以随时删除。
            </p>
            <form onSubmit={saveMemory} className="memory-form">
              <label htmlFor="memory">保存研究偏好</label>
              <Textarea
                id="memory"
                value={memoryText}
                maxLength={300}
                onChange={(e) => setMemoryText(e.target.value)}
                placeholder="例如：研究公司时重点关注现金流，输出简短摘要。"
              />
              <div>
                <span>只保存你主动提供的内容</span>
                <Button disabled={busy || !memoryText.trim() || !boot}>
                  <Plus size={14} />
                  保存偏好
                </Button>
              </div>
            </form>
            {boot?.memories.length ? (
              <div className="memory-grid">
                {boot.memories.map((m) => (
                  <div key={m.id} className="memory-card">
                    <BookOpen size={19} />
                    <p>{m.text}</p>
                    <div>
                      <span>保存于 {dateLabel(m.createdAt)}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="删除研究偏好"
                        onClick={() => removeMemory(m.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-panel">
                <BookOpen size={32} />
                <h3>还没有保存研究偏好</h3>
                <p>可以记录关注指标、报告长度或常用研究范围。</p>
              </div>
            )}
          </section>
        )}
        {view === "tools" && (
          <section className="secondary-page">
            <div className="eyebrow">CAPABILITIES & CONNECTIONS</div>
            <h1>研究能力，一目了然</h1>
            <p className="page-intro">
              计划只能使用已注册的工具。服务未配置或数据不可用时，会保留明确的缺口。
            </p>
            <div className="inline-note">
              <BrainCircuit size={16} />
              {boot?.config.model
                ? "已配置模型服务；实际调用结果和降级原因会记录在研究运行记录中。"
                : "AI 尚未接入：目标识别与计划由规则代码生成，报告由证据模板与确定性计算整理。需要配置服务地址、模型名称与 API key 后，才会调用真实大模型。"}
            </div>
            <div className="connection-grid">
              <Connection
                title="规划与解释模型"
                ready={!!boot?.config.model}
                text={
                  boot?.config.model
                    ? (boot.config.modelName ?? "已配置")
                    : "未配置 API key，当前没有真实大模型参与"
                }
              />
              <Connection
                title="扶摇金融数据"
                ready={!!boot?.config.fuyao}
                text={
                  boot?.config.fuyao
                    ? "已配置，实际权限以调用结果为准"
                    : "待配置，可接入行情、财报与估值"
                }
              />
              <Connection
                title="腾讯公开行情"
                ready
                text="无需密钥的备用来源；可用性以调用结果为准"
              />
            </div>
            <div className="capability-note">
              <ShieldCheck size={18} />
              <p>
                密钥由服务端管理。真实数据模式不会静默切换为构造数据。iFinD
                需要单独的账号权限，本版尚未接入。部署与配置方式见项目 README。
              </p>
            </div>
            <div className="tool-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>工具</TableHead>
                    <TableHead>数据能力</TableHead>
                    <TableHead>权限</TableHead>
                    <TableHead>调用成本</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(toolRegistry).map(([name, t]) => (
                    <TableRow key={name}>
                      <TableCell>
                        <strong>{t.title}</strong>
                        <code>{name}</code>
                      </TableCell>
                      <TableCell>{t.description}</TableCell>
                      <TableCell>
                        <span className="permission-tag">{t.permission}</span>
                      </TableCell>
                      <TableCell>
                        {t.cost}
                        <small>超时 {t.timeoutMs / 1000}s</small>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="execution-boundary">
              <h3>执行边界</h3>
              <p>
                每轮最多 4
                个标的。超过默认范围或调用额度时请求确认；单轮调用硬上限 40
                次，累计执行时限 4
                分钟。所有金融工具均为只读，模型不能调用任意接口或执行交易。
              </p>
            </div>
          </section>
        )}
      </main>
      <Sheet
        open={!!selectedEvidence}
        onOpenChange={(open) => {
          if (!open) setSelectedEvidence(null);
        }}
      >
        <SheetContent className="evidence-sheet sm:max-w-[560px] w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>证据详情</SheetTitle>
            <SheetDescription>从结论回到原始字段与计算依据</SheetDescription>
          </SheetHeader>
          {selectedEvidence && (
            <EvidenceDetail
              evidence={selectedEvidence}
              all={run?.evidence ?? []}
              onSelect={setSelectedEvidence}
            />
          )}
        </SheetContent>
      </Sheet>
    </SidebarProvider>
  );
}
function Connection({
  title,
  ready,
  text,
}: {
  title: string;
  ready: boolean;
  text: string;
}) {
  return (
    <div className="connection-card">
      <div>
        <Database size={18} />
        <span className={ready ? "connection-ready" : "connection-pending"}>
          {ready ? "接入已配置" : "待配置"}
        </span>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function EventRow({ event: e }: { event: ResearchEvent }) {
  const warning = /error|fallback|gap|quality|rejected/.test(e.type);
  return (
    <li className={warning ? "event warning" : "event"}>
      <span className="event-icon">
        {warning ? (
          <AlertTriangle size={13} />
        ) : e.type === "tool_success" ? (
          <Check size={13} />
        ) : (
          <Activity size={13} />
        )}
      </span>
      <div>
        <strong>{e.message}</strong>
        {e.detail && <p>{e.detail}</p>}
        <span>
          {dateLabel(e.at)} · {e.type}
          {e.durationMs !== undefined
            ? ` · ${(e.durationMs / 1000).toFixed(2)}s`
            : ""}
        </span>
      </div>
    </li>
  );
}
function EvidenceDetail({
  evidence: e,
  all,
  onSelect,
}: {
  evidence: Evidence;
  all: Evidence[];
  onSelect: (e: Evidence) => void;
}) {
  return (
    <div className="evidence-detail">
      <span className={`quality-label ${e.quality}`}>
        {e.quality === "demo"
          ? "构造数据"
          : e.quality === "missing"
            ? "数据缺失"
            : e.quality === "stale"
              ? "可能过期"
              : "已保存证据"}
      </span>
      <h2>
        {e.security.name} · {e.label}
      </h2>
      <div className="detail-value">
        {valueLabel(e)}
        <span>{e.unit}</span>
      </div>
      <dl>
        {[
          ["证券代码", e.security.code],
          ["数据时点", e.asOf],
          ["获取时间", new Date(e.retrievedAt).toLocaleString("zh-CN")],
          ["数据来源", e.source],
          ["原始字段", e.field],
          ["统计口径", e.basis],
          ["证据 ID", e.id],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {e.sourceUrl && (
        <a
          className="source-link"
          href={e.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} />
          打开来源接口（可能需要权限）
        </a>
      )}
      {e.note && (
        <div className="detail-note">
          <AlertTriangle size={15} />
          {e.note}
        </div>
      )}
      {e.formula && (
        <div className="formula-block">
          <h3>可复算公式</h3>
          <code>{e.formula}</code>
          <div className="citation-list">
            {e.inputIds?.map((id) => {
              const input = all.find((x) => x.id === id);
              return input ? (
                <button key={id} onClick={() => onSelect(input)}>
                  <Link2 size={12} />
                  {input.label}
                </button>
              ) : null;
            })}
          </div>
        </div>
      )}
      <h3>原始记录</h3>
      <pre className="raw-evidence">{JSON.stringify(e.raw, null, 2)}</pre>
    </div>
  );
}
function PriceChart({ evidence }: { evidence: Evidence[] }) {
  const item = evidence.find((e) => e.series?.length && e.value !== null);
  if (!item?.series) return null;
  return (
    <div className="price-chart">
      <div>
        <h3>
          {item.security.name} · 历史收盘
          {item.security.kind === "index" ? "点位" : "价"}
        </h3>
        <span>
          {item.quality === "demo" ? "构造数据" : item.source} · {item.unit}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart
          data={item.series}
          margin={{ top: 20, right: 8, bottom: 0, left: -20 }}
        >
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4169e8" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#4169e8" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 5"
            vertical={false}
            stroke="#e7ecf4"
          />
          <XAxis
            dataKey="date"
            minTickGap={60}
            tick={{ fontSize: 12, fill: "#8794aa" }}
            tickFormatter={(value) => String(value).slice(5)}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 12, fill: "#8794aa" }}
            axisLine={false}
            tickLine={false}
            width={65}
          />
          <Tooltip
            formatter={(value) => [
              `${Number(value).toFixed(2)} ${item.unit}`,
              "收盘",
            ]}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid #e0e7f1",
              fontSize: 13,
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#4169e8"
            strokeWidth={2}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
