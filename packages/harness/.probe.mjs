import { chromium } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

const [, , URL, LABEL, OUT, TREE] = process.argv;
const RENDERS = path.join(TREE, ".sapiom", "canvas", "renders");
const rendered = () => existsSync(RENDERS) && readdirSync(RENDERS).some((f) => f.startsWith("research-notes-"));

const browser = await chromium.launch();

async function open(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("sapiom-harness-theme", t), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  if (await page.getByTestId("help-overlay").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
  await page.getByText("research-notes", { exact: false }).first().click();
  await page.waitForTimeout(2000);
  const start = page.getByRole("button", { name: /start session/i });
  if (await start.count()) await start.first().click();
  return { ctx, page };
}

// Warm-up pass: create the session and wait for the artifact the iframe loads.
{
  const { ctx } = await open("dark");
  for (let i = 0; i < 300 && !rendered(); i++) await new Promise((r) => setTimeout(r, 1000));
  console.log(`${LABEL}: render on disk =`, rendered());
  await ctx.close();
}

for (const theme of ["light", "dark"]) {
  let ok = false;
  // The board sometimes mounts before the render is served; one reopen settles it.
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const { ctx, page } = await open(theme);
    const card = page.getByTestId("canvas-render-error");
    try { await card.waitFor({ state: "visible", timeout: 60_000 }); ok = true; } catch { /* retry */ }
    if (ok) {
      await page.waitForTimeout(4000);
      const shell = await page.evaluate(() => document.documentElement.dataset.theme);
      const canvasTheme = await page.frameLocator("iframe.canvas-iframe").locator(":root").getAttribute("data-canvas-theme");
      const prose = page.frameLocator("iframe.canvas-iframe").getByText(/Could not extract this agent's step graph/);
      const proseVisible = (await prose.count()) ? await prose.first().isVisible() : false;
      console.log(`${LABEL}/${theme}: card=1 shell=${shell} canvas=${canvasTheme} documentProseVisible=${proseVisible} (attempt ${attempt})`);
      await page.screenshot({ path: `${OUT}/${LABEL}-${theme}.png` });
    }
    await ctx.close();
  }
  if (!ok) console.log(`${LABEL}/${theme}: !! no card after 3 attempts`);
}
await browser.close();
