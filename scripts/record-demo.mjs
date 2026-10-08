import { chromium } from "playwright";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
const directory = path.resolve(process.env.DEMO_DIR || "../xbuddy-demo-assets");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: directory, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();
page.setDefaultTimeout(65000);
const wait = (ms) => page.waitForTimeout(ms);
const began = Date.now();
try {
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5173");
  await page.locator('main[aria-busy="false"]').waitFor();
  await wait(4000);
  await page
    .getByRole("textbox", { name: "研究目标" })
    .pressSequentially(
      "研究中国CPI当月同比从2025-01-01至2025-12-31的变化，注明来源、单位和频率。",
      { delay: 55 },
    );
  await wait(2000);
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .waitFor();
  await wait(6000);
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await page.getByText("研究已完成", { exact: true }).last().waitFor();
  await wait(7000);
  await page
    .getByRole("button", { name: /^证据 \d+$/, exact: true })
    .first()
    .click();
  await wait(9000);
  await page.keyboard.press("Escape");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  const report = await downloading;
  await report.saveAs(path.join(directory, "示例研究报告.md"));
  await wait(2000);
  await page.getByText("查看研究过程", { exact: false }).first().click();
  await wait(5000);
  await page.getByRole("tab", { name: "运行记录" }).click();
  await wait(7000);
  await page.reload();
  await page.getByText("研究已完成", { exact: true }).last().waitFor();
  await wait(5000);
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByText("iFinD MCP", { exact: true }).scrollIntoViewIfNeeded();
  await wait(5000);
  await page
    .getByRole("button", { name: "验证连接并发现工具", exact: true })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^账户工具清单/ })
    .waitFor();
  await page
    .locator("summary")
    .filter({ hasText: /^账户工具清单/ })
    .click();
  await wait(6000);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("textbox", { name: "研究目标" })
    .pressSequentially(
      "研究贵州茅台2026-09-01至2026-10-08的经营相关新闻，区分报道与推断。",
      { delay: 50 },
    );
  await page.getByRole("button", { name: "生成研究计划", exact: true }).click();
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .waitFor();
  await wait(4000);
  await page
    .getByRole("button", { name: "确认并开始研究", exact: true })
    .click();
  await page.getByText("研究已完成", { exact: true }).last().waitFor();
  await wait(6000);
  await page
    .getByRole("button", { name: /^证据 \d+$/, exact: true })
    .first()
    .click();
  await wait(8000);
  await page.screenshot({
    path: path.join(directory, "新闻证据.png"),
    fullPage: true,
  });
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(directory, "投资XBuddy演示.webm"));
  console.log(
    JSON.stringify({
      video: path.join(directory, "投资XBuddy演示.webm"),
      durationSeconds: Math.round((Date.now() - began) / 1000),
    }),
  );
} finally {
  await browser.close();
}
