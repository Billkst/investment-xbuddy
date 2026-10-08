import { test, expect } from "@playwright/test";

test("访客可配置个人模型，测试连接、清除密钥且不意外开启共享调用", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByText("站点共享服务", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "模型来源", exact: true }).click();
  await page
    .getByRole("option", { name: "使用我的 API key", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "个人 API key",
    exact: true,
  });
  await input.fill("test-ui-key-not-a-real-key");
  await page.route("**/api/research", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === "model_test") {
      expect(body.modelCredential.apiKey).toBe("test-ui-key-not-a-real-key");
      expect(body.modelSelection).not.toHaveProperty("apiKey");
      await route.fulfill({ json: { ok: true, model: "deepseek-flash" } });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "JSON 输出检查通过" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect(page.locator(".mode-pill.neutral")).toHaveText(
    "个人模型 · 已配置",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("test-ui-key");
  await page.screenshot({
    path: "test-results/model-settings-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "清除个人密钥", exact: true }).click();
  await expect(page.locator(".mode-pill.neutral")).toHaveText(
    "规则运行 · 无模型调用",
  );
  await page.getByRole("button", { name: "清除个人密钥", exact: true }).click();
  await expect(page.locator(".mode-pill.neutral")).toHaveText(
    "规则运行 · 无模型调用",
  );
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("combobox", { name: "模型来源", exact: true }).click();
  await page
    .getByRole("option", { name: "使用我的 API key", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/model-settings-mobile.png",
    fullPage: true,
  });
});
