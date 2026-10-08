import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("combobox", { name: "模型来源", exact: true }).click();
  await page
    .getByRole("option", { name: "仅使用规则，不调用模型", exact: true })
    .click();
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
});

test("全部功能免登录开放，工作台与偏好在新标签页恢复并与其他访客隔离", async ({
  page,
  context,
  browser,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));

  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("link", { name: /登录/ })).toHaveCount(0);
  await expect(
    page.getByText("规则运行 · 无模型调用", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "研究记忆", exact: true }).click();
  await page
    .getByRole("textbox", { name: "保存研究偏好" })
    .fill("免登录偏好：重点关注现金流，报告输出摘要");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(page.locator(".memory-card")).toContainText("免登录偏好");
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("研究贵州茅台最近三年的盈利质量");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  await page.locator(".process-details > summary").click();
  await page.getByRole("tab", { name: "证据与上下文", exact: true }).click();
  await expect(page.locator(".context-card")).toContainText("1 条");
  const url = page.url();
  const newTab = await context.newPage();
  await newTab.goto(url);
  await expect(
    newTab.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  await newTab.getByRole("button", { name: /研究记忆/ }).click();
  await expect(newTab.locator(".memory-card")).toContainText("免登录偏好");
  const cookie = (await context.cookies()).find(
    (c) => c.name === "xbuddy-workspace-dev",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 86400);

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto(url);
  await expect(other.getByRole("alert")).toContainText("研究不存在或无权访问");
  await other.getByRole("button", { name: "研究记忆", exact: true }).click();
  await expect(other.locator(".memory-card")).toHaveCount(0);
  await otherContext.close();

  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByText("研究额度与本地记录", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清空工作台", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "研究目标" })).toHaveValue("");
  await page.getByRole("button", { name: "研究记忆", exact: true }).click();
  await expect(page.locator(".memory-card")).toHaveCount(0);
  await newTab.reload();
  await expect(newTab.getByRole("alert")).toContainText("研究不存在或无权访问");
  await newTab.close();
  expect(
    requests.some((url) => /signin|signout|oauth|callback/.test(url)),
  ).toBe(false);
});

test("禁用草稿存储不影响免登录执行，手机入口无需账号", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("storage denied");
    };
  });
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("combobox", { name: "模型来源", exact: true }).click();
  await page
    .getByRole("option", { name: "仅使用规则，不调用模型", exact: true })
    .click();
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("沪深300近三个月最大回撤");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await expect(page.locator(".status-badge")).toContainText("研究已完成");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/no-login-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
