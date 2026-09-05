import { chromium } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

const [, , URL, LABEL, OUT, TREE] = process.argv;
const RENDERS = path.join(TREE, ".sapiom", "canvas", "renders");
const renderExists = () =>
  existsSync(RENDERS) && readdirSync(RENDERS).some((f) => f.startsWith("research-notes-"));

const browser = await chromium.launch();
const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const boot = await ctx0.newPage();
await boot.goto(URL, { waitUntil: "domcontentloaded" });
await boot.waitForTimeout(3000);
if (await boot.getByTestId("help-overlay").count()) { await boot.keyboard.press("Escape"); await boot.waitForTimeout(600); }
await boot.getByText("research-notes", { exact: false }).first().click();
await boot.waitForTimeout(2000);
const start = boot.getByRole("button", { name: /start session/i });
if (await start.count()) { await start.first().click(); console.log(`${LABEL}: session started`); }

// Wait on the artifact itself, which is what the iframe will load.
for (let i = 0; i < 300 && !renderExists(); i++) await boot.waitForTimeout(1000);
console.log(`${LABEL}: render on disk =`, renderExists());
await ctx0.close();

// Fresh context per theme, opened AFTER the render exists, so the iframe loads it.
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("sapiom-harness-theme", t), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  if (await page.getByTestId("help-overlay").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(600); }
  await page.getByText("research-notes", { exact: false }).first().click();

  const card = page.getByTestId("canvas-render-error");
  try { await card.waitFor({ state: "visible", timeout: 120_000 }); }
  catch { console.log(`${LABEL}/${theme}: !! no card`); }
  await page.waitForTimeout(4000);

  const shell = await page.evaluate(() => document.documentElement.dataset.theme);
  const canvasTheme = await page.frameLocator("iframe.canvas-iframe").locator(":root").getAttribute("data-canvas-theme");
  const prose = page.frameLocator("iframe.canvas-iframe").getByText(/Could not extract this agent's step graph/);
  const proseVisible = (await prose.count()) ? await prose.first().isVisible() : false;
  console.log(`${LABEL}/${theme}: card=${await card.count()} shell=${shell} canvas=${canvasTheme} documentProseVisible=${proseVisible}`);
  await page.screenshot({ path: `${OUT}/${LABEL}-${theme}.png` });
  await ctx.close();
}
await browser.close();
