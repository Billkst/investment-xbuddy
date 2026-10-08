import { test, expect } from "@playwright/test";
import { createRun } from "../../lib/research/types";
import { advanceRun, applyAction } from "../../lib/research/engine";

test("默认共享模型可规划首页第三个示例并完成真实研究", async ({ page }) => {
  test.setTimeout(180000);
  let lastRun: any;
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/api/research") &&
      response.request().method() === "POST"
    ) {
      try {
        const data = await response.json();
        if (data.run) lastRun = data.run;
      } catch {}
    }
  });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /比较茅台与五粮液/ }).click();
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible({ timeout: 35000 });
  expect(
    lastRun.planner,
    JSON.stringify(
      lastRun.events.filter((e: any) => e.type === "model_fallback"),
    ),
  ).toBe("model");
  await expect(page.getByText("AI 规划未成功", { exact: false })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await expect(
    page.getByText("研究已完成", { exact: true }).last(),
  ).toBeVisible({ timeout: 120000 });
  expect(
    lastRun.evidence.some((e: any) => e.quality === "verified"),
  ).toBeTruthy();
  expect(
    lastRun.report.findings.some(
      (f: any) => f.kind === "fact" && f.evidenceIds.length,
    ),
  ).toBeTruthy();
  expect(
    lastRun.steps
      .filter((s: any) => s.tool === "finance.valuation")
      .every((s: any) => s.status === "succeeded"),
  ).toBeTruthy();
  console.log(
    JSON.stringify({
      planner: lastRun.planner,
      modelCalls: lastRun.usage.modelCalls,
      evidence: lastRun.evidence.length,
      status: lastRun.status,
      failed: lastRun.steps
        .filter((s: any) => s.status === "failed")
        .map((s: any) => ({ tool: s.tool, error: s.error })),
    }),
  );
});

test("规划失败可见具体原因，重试后的计划仍等待确认（模拟故障）", async ({
  page,
}) => {
  const run = createRun("比较贵州茅台和五粮液的现金流", "live");
  run.modelSelection = { source: "site" };
  await advanceRun(run, { contextLimit: 16000 });
  run.events.find((e) => e.type === "model_fallback")!.detail =
    "模型规划失败：模型选择了未注册的数据能力。已启用规则规划降级。";
  let retried = false;
  await page.route("**/api/research", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    if (body.action === "retry_plan") {
      applyAction(run, "retry_plan");
      retried = true;
    } else if (body.action === "advance" && retried) {
      await advanceRun(run, { contextLimit: 16000 });
      run.planner = "model";
    } else if (body.action !== "create" && body.action !== "advance")
      return route.continue();
    return route.fulfill({ json: { run } });
  });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /比较茅台与五粮液/ }).click();
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(page.locator(".planning-notice")).toContainText(
    "未注册的数据能力",
  );
  await page
    .getByRole("button", { name: "重新尝试 AI 规划", exact: true })
    .click();
  await expect(page.locator(".planning-notice")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  expect(retried).toBeTruthy();
  expect(run.status).toBe("ready");
});
