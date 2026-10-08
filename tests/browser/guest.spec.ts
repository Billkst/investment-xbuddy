import { test, expect } from "@playwright/test";

test("存储受限时显示提示而不崩溃，损坏记录可清除后重新体验", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("guest-storage-tested")) {
      sessionStorage.setItem("guest-storage-tested", "yes");
      Storage.prototype.getItem = () => {
        throw new Error("storage denied");
      };
      Storage.prototype.setItem = () => {
        throw new Error("storage denied");
      };
    } else {
      sessionStorage.setItem("xbuddy-guest-v1", "bad JSON");
    }
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("浏览器禁止临时存储");
  await expect(page.getByRole("textbox", { name: "研究目标" })).toBeVisible();
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("临时研究记录无法读取");
  await page.getByRole("button", { name: "清除临时记录", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("研究沪深300近期回撤");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "执行计划", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("访客无需登录完成自由目标、暂停恢复、审批、证据和导出，且不写入服务端", async ({
  page,
  browser,
}) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByText("免登录，直接开始研究体验", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("比较贵州茅台和五粮液近三年盈利质量与现金流");
  await page.getByText("执行与验证选项", { exact: true }).click();
  await page.getByRole("combobox", { name: "调用额度", exact: true }).click();
  await page.getByRole("option", { name: "1 次", exact: true }).click();
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "执行计划", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "贵州茅台 × 五粮液", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "执行计划", exact: true }).click();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".status-badge")).toContainText("已暂停");
  const url = page.url();
  await page.reload();
  await expect(page.locator(".status-badge")).toContainText("已暂停");
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "继续研究前，确认调用额度" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await expect(page.locator(".status-badge")).toContainText("研究已完成", {
    timeout: 30000,
  });
  await page
    .getByRole("button", { name: "证据 1", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "证据详情", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告" }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/XBuddy-run_.*\.md/);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出报告" })).toBeVisible();
  expect(page.url()).toBe(url);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/guest-report.png",
    fullPage: true,
  });

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto(url);
  await expect(otherPage.getByRole("alert")).toContainText("没有这条临时研究");
  await otherContext.close();

  await page.getByRole("button", { name: "清除临时记录", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "研究目标" })).toHaveValue("");
  expect(
    await page.evaluate(() => sessionStorage.getItem("xbuddy-guest-v1")),
  ).toBeNull();
});

test("手机访客可直接体验，登录不会把临时记录写入个人空间", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("研究沪深300近三个月的最大回撤，访客独立记录");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "执行计划", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const runId = new URL(page.url()).searchParams.get("run");
  await page.screenshot({
    path: "test-results/guest-mobile.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "登录并保存研究", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const data = await page.evaluate(
    async () =>
      (await fetch("/api/research")).json() as Promise<{
        authenticated: boolean;
        runs: { id: string }[];
      }>,
  );
  expect(data.authenticated).toBe(true);
  expect(data.runs.some((run: { id: string }) => run.id === runId)).toBe(false);
  await expect(
    page.getByText("免登录，直接开始研究体验", { exact: true }),
  ).toHaveCount(0);
});
