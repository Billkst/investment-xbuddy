import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  parseModelSelection,
  modelProviders,
  modelRequestOptions,
  modelRuntime,
} from "../lib/research/model-settings.ts";
import {
  reserveModelSql,
  settleModelSql,
  unusedModelTokens,
  modelCooldownSql,
} from "../lib/research/model-budget.ts";
import { modelJson } from "../lib/research/planner.ts";
import { createRun } from "../lib/research/types.ts";
import {
  advanceRun,
  applyAction,
  compressContext,
  researchContext,
} from "../lib/research/engine.ts";
const credential = {
  provider: "groq",
  model: "openai/gpt-oss-120b",
  apiKey: "test-credential-do-not-use",
};
const personal = parseModelSelection({
  source: "personal",
  ...credential,
  baseUrl: "https://attacker.invalid",
});
const site = {
  contextLimit: 16000,
  llmApiKey: "site-secret-test-only",
  llmBaseUrl: "https://api.groq.com/openai/v1",
  llmModel: "openai/gpt-oss-120b",
};
test("credential metadata is whitelisted; providers cannot override destinations", () => {
  assert.deepEqual(personal, {
    source: "personal",
    provider: "groq",
    model: credential.model,
  });
  assert.equal(JSON.stringify(personal).includes(credential.apiKey), false);
  assert.throws(() =>
    parseModelSelection({
      source: "personal",
      provider: "__proto__",
      model: "x",
    }),
  );
  assert.equal(
    modelRuntime(
      personal,
      { ...credential, baseUrl: "https://attacker.invalid" },
      site,
    ).llmBaseUrl,
    site.llmBaseUrl,
  );
  assert.throws(() => modelRuntime(personal, undefined, site), /重新填写/);
  assert.throws(
    () =>
      modelRuntime(personal, { ...credential, provider: "openrouter" }, site),
    /不一致/,
  );
  assert.equal(
    modelRuntime({ source: "rules" }, credential, site).llmApiKey,
    undefined,
  );
  assert.equal(
    modelRuntime({ source: "site" }, credential, site).llmApiKey,
    site.llmApiKey,
  );
});
test("run call budget rejects before reserving shared capacity or sending a request", async () => {
  const run = createRun("茅台走势", "demo");
  run.usage.calls = run.budget.maxCalls;
  let reserved = 0;
  await assert.rejects(
    modelJson(
      run,
      {
        ...site,
        beforeModelCall: async () => {
          reserved++;
        },
      },
      "s",
      "i",
    ),
  );
  assert.equal(reserved, 0);
});
test("Chinese inputs reserve UTF-8 capacity; request blocks redirects and credentials stay outside run", async () => {
  const original = globalThis.fetch;
  let reserved = 0;
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts?.redirect, "manual");
    assert.equal(
      new Headers(opts?.headers).get("authorization"),
      "Bearer " + credential.apiKey,
    );
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { total_tokens: 180 },
    });
  };
  const run = createRun("研究茅台", "demo");
  try {
    const config = modelRuntime(personal, credential, site);
    config.beforeModelCall = async (n) => {
      reserved = n;
    };
    assert.deepEqual(
      await modelJson(run, config, "中文规则", "中文目标", 256),
      { ok: true },
    );
    assert.ok(
      reserved >= new TextEncoder().encode("中文规则中文目标").byteLength + 256,
    );
    assert.equal(run.usage.tokens, 180);
    assert.equal(JSON.stringify(run).includes(credential.apiKey), false);
  } finally {
    globalThis.fetch = original;
  }
});
test("quota batch rolls back earlier buckets and migrations preserve previous usage", () => {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync("drizzle")
    .filter((x) => x.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    if (migration.startsWith("0003"))
      db.exec(
        "INSERT INTO model_usage VALUES ('preserved',2,400,9999999999999)",
      );
    db.exec(
      readFileSync("drizzle/" + migration, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  }
  assert.equal(
    db.prepare("SELECT calls FROM model_usage WHERE bucket='preserved'").get()
      ?.calls,
    2,
  );
  assert.equal(
    db
      .prepare("SELECT call_limit FROM model_usage WHERE bucket='preserved'")
      .get()?.call_limit,
    5000,
  );
  const reserve = (names: string[], tokens: number) => {
    db.exec("BEGIN");
    try {
      for (const name of names)
        db.prepare(reserveModelSql).run(name, tokens, 9999999999999, 1, 1000);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  reserve(["minute"], 100);
  assert.throws(
    () => reserve(["day", "minute"], 100),
    /CHECK constraint failed/,
  );
  assert.equal(
    db.prepare("SELECT calls FROM model_usage WHERE bucket='day'").get(),
    undefined,
  );
  assert.throws(() => reserve(["tokens"], 1001), /CHECK constraint failed/);
  reserve(["workspace:personal"], 100);
  reserve(["workspace:shared"], 100);
  db.close();
});
test("report projection preserves provenance, endpoints and sample counts after compression", async () => {
  const run = createRun("茅台近一年走势", "demo");
  await advanceRun(run);
  applyAction(run, "start");
  for (let i = 0; i < 12 && run.status !== "completed"; i++)
    await advanceRun(run);
  const raw = JSON.stringify(run.evidence);
  compressContext(run, 0, true);
  const context = JSON.parse(researchContext(run, false));
  assert.equal(context.summary, run.context.summary);
  for (const e of run.evidence) {
    const projected = context.evidence.find(
      (x: { id: string }) => x.id === e.id,
    );
    assert.ok(projected);
    assert.equal(projected.series, undefined);
    assert.equal(projected.note, e.note);
    assert.deepEqual(projected.inputIds, e.inputIds);
    if (e.series?.length) {
      assert.equal(projected.seriesSummary.sampleCount, e.series.length);
      assert.deepEqual(projected.seriesSummary.first, e.series[0]);
      assert.deepEqual(projected.seriesSummary.last, e.series.at(-1));
    }
  }
  assert.equal(JSON.stringify(run.evidence), raw);
});

test("国产模型使用各自官方地址与 JSON 参数，Kimi 不注入不兼容采样设置", async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of [
      "deepseek",
      "qwen",
      "glm",
      "kimi",
      "siliconflow",
      "doubao",
    ] as const) {
      const preset = modelProviders[provider];
      const selection = parseModelSelection({
        source: "personal",
        provider,
        model: preset.defaultModel,
      });
      const config = modelRuntime(
        selection,
        { provider, model: preset.defaultModel, apiKey: credential.apiKey },
        site,
      );
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), preset.baseUrl + "/chat/completions");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.equal(body.temperature, undefined);
        assert.equal(body.model, preset.defaultModel);
        if (provider === "qwen" || provider === "siliconflow")
          assert.equal(body.enable_thinking, false);
        else assert.deepEqual(body.thinking, { type: "disabled" });
        return Response.json({
          choices: [{ message: { content: '{"ok":true}' } }],
        });
      };
      assert.deepEqual(
        await modelJson(
          createRun("研究茅台", "live"),
          config,
          "输出JSON",
          "研究",
        ),
        { ok: true },
      );
    }
    assert.deepEqual(
      modelRequestOptions(modelProviders.glm.baseUrl, "glm-5.3"),
      {},
    );
    assert.deepEqual(
      modelRequestOptions(modelProviders.doubao.baseUrl, "ep-custom"),
      {},
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("unused token reservations are refunded atomically without refunding calls or other requests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE model_usage (bucket TEXT PRIMARY KEY,calls INTEGER,tokens INTEGER,expires_at INTEGER,call_limit INTEGER,token_limit INTEGER)",
  );
  db.prepare(reserveModelSql).run("shared", 7000, 1, 10, 20000);
  db.prepare(reserveModelSql).run("shared", 5000, 1, 10, 20000);
  db.prepare(settleModelSql).run(unusedModelTokens(7000, 2300), "shared");
  assert.deepEqual(
    { ...db.prepare("SELECT calls,tokens FROM model_usage").get()! },
    { calls: 2, tokens: 7300 },
  );
  db.prepare(settleModelSql).run(unusedModelTokens(5000, 1200), "shared");
  assert.deepEqual(
    { ...db.prepare("SELECT calls,tokens FROM model_usage").get()! },
    { calls: 2, tokens: 3500 },
  );
  assert.equal(unusedModelTokens(7000, -1), 0);
  assert.equal(unusedModelTokens(7000, 8000), 0);
  db.prepare(modelCooldownSql).run("cooldown:site", 90000);
  db.prepare(modelCooldownSql).run("cooldown:site", 80000);
  assert.equal(
    db
      .prepare(
        "SELECT expires_at FROM model_usage WHERE bucket='cooldown:site'",
      )
      .get()?.expires_at,
    90000,
  );
  db.close();
});
