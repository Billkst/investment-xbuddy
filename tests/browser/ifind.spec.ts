import { test, expect } from "@playwright/test";
test("iFinD 连接验证、真实工具清单与研究接入状态分开显示", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const button = page.getByRole("button", {
    name: "验证连接并发现工具",
    exact: true,
  });
  test.skip(!(await button.isEnabled()), "本地未配置 iFinD MCP 密钥");
  await button.click();
  const list = page.locator("summary").filter({ hasText: /^账户工具清单/ });
  await expect(list).toBeVisible({ timeout: 35000 });
  await expect(
    page.getByText(
      "9 项只读工具已接入研究。系统按目标调用，原文与指标保留来源；缺少单位或日期的结果标为待核对。",
    ),
  ).toBeVisible();
  await list.click();
  await expect(page.locator(".ifind-tool").first()).toBeVisible();
  await page.locator(".ifind-tool summary").first().click();
  await expect(page.locator(".ifind-tool pre").first()).toContainText(
    '"type": "object"',
  );
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(
    page.locator("summary").filter({ hasText: /^账户工具清单/ }),
  ).toBeVisible();
});

test("无证券的宏观研究和新闻原文可核查、导出、刷新恢复", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("combobox", { name: "模型来源", exact: true }).click();
  await page
    .getByRole("option", { name: "仅使用规则，不调用模型", exact: true })
    .click();
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("研究中国CPI当月同比，从2025-01-01至2025-12-31，注明单位与来源。");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始研究", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await expect(
    page.getByText("研究已完成", { exact: true }).last(),
  ).toBeVisible({ timeout: 65000 });
  await expect(page.locator(".report-card")).toContainText("CPI");
  await page
    .getByRole("button", { name: /^证据 \d+$/, exact: true })
    .first()
    .click();
  await expect(page.locator(".evidence-detail")).toContainText("国家统计局");
  await expect(page.locator(".raw-evidence")).toContainText("fetch_edb");
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  await download;
  await page.reload();
  await expect(
    page.getByText("研究已完成", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("textbox", { name: "研究目标" })
    .fill("研究贵州茅台2026-09-01至2026-10-08的经营相关新闻。");
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await expect(
    page.getByText("研究已完成", { exact: true }).last(),
  ).toBeVisible({ timeout: 65000 });
  await expect(page.locator(".report-card")).toContainText("记载");
  await page
    .getByRole("button", { name: /^证据 \d+$/, exact: true })
    .first()
    .click();
  await expect(page.locator(".text-evidence")).toBeVisible();
  await expect(page.locator(".evidence-detail")).toContainText("片段");
  await page.screenshot({
    path: "test-results/ifind-news-evidence.png",
    fullPage: true,
  });
});
