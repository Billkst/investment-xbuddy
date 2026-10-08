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
    page.getByText("先验证连接，再接入研究流程；当前研究尚未使用 iFinD 数据。"),
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
