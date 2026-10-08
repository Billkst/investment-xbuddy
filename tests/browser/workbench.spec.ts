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
test("免登录首页、自由目标、审批、报告、证据与刷新恢复", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await expect(
    page.getByRole("heading", { name: "把一个投资问题，研究清楚。" }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
  });
  await expect(page.getByRole("link", { name: /登录/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "数据模式" })).toHaveCount(0);
  await expect(page.getByText("构造数据演示", { exact: true })).toHaveCount(0);
  await expect(page.locator(".profile")).toContainText("免登录研究工作台");
  await page.getByRole("button", { name: /比较茅台与五粮液/ }).click();
  await expect(page.getByRole("textbox", { name: "研究目标" })).toHaveValue(
    /现金流/,
  );
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByText("研究额度与本地记录", { exact: true }).click();
  await page.getByRole("combobox", { name: "调用额度", exact: true }).click();
  await page.getByRole("option", { name: "1 次", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page.getByRole("button", { name: /比较茅台与五粮液/ }).click();
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "贵州茅台 × 五粮液", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "继续研究前，确认调用额度" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/approval-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await expect(
    page.getByText("研究已完成", { exact: true }).last(),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("button", { name: "导出报告" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "研究发现" })).toBeVisible();
  await page
    .getByRole("button", { name: /^证据 \d+$/, exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "证据详情", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("原始记录", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "证据详情", exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: "test-results/report-desktop.png",
    fullPage: true,
  });
  const url = page.url();
  await page.reload();
  await expect(page.getByRole("button", { name: "导出报告" })).toBeVisible();
  expect(page.url()).toBe(url);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告" }).click();
  expect((await download).suggestedFilename()).toMatch(/XBuddy-run_.*\.md/);
  expect(errors).toEqual([]);
});
test("长期记忆可保存和删除", async ({ page }) => {
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "研究记忆", exact: true }).click();
  await page
    .getByRole("textbox", { name: "保存研究偏好" })
    .fill("浏览器验证：重点关注现金流，报告保持简短。");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(
    page.getByText("浏览器验证：重点关注现金流，报告保持简短。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: /研究记忆/ }).click();
  await expect(
    page.getByText("浏览器验证：重点关注现金流，报告保持简短。", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".memory-card")
    .filter({ hasText: "浏览器验证：" })
    .getByRole("button", { name: "删除研究偏好" })
    .click();
  await expect(
    page.getByText("浏览器验证：重点关注现金流，报告保持简短。", {
      exact: true,
    }),
  ).toHaveCount(0);
});
test("手机布局与导航不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.getByRole("textbox", { name: "研究目标" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
});
