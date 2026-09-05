import { chromium } from "@playwright/test";
const [, , URL, LABEL, OUT] = process.argv;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("sapiom-harness-theme", "light"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const help = page.getByTestId("help-overlay");
if (await help.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(600); }

await page.getByText("research-notes", { exact: false }).first().click();
await page.waitForTimeout(2000);
const start = page.getByRole("button", { name: /start session/i });
if (await start.count()) { await start.first().click(); console.log("started a session"); }

const card = page.getByTestId("canvas-render-error");
try { await card.waitFor({ state: "visible", timeout: 180_000 }); }
catch { console.log("!! no render-error card"); }
await page.waitForTimeout(3500);
console.log(`${LABEL}: card present =`, await card.count());
await page.screenshot({ path: `${OUT}/${LABEL}-light.png` });
await ctx.close();
await browser.close();
