import { chromium } from "@playwright/test";
const [, , URL] = process.argv;
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
const card = page.getByTestId("canvas-render-error");
try { await card.waitFor({ state: "visible", timeout: 180_000 }); }
catch { console.log("!! no render-error card"); }
await page.waitForTimeout(3500);
console.log("card present    =", await card.count());
console.log("root data-theme =", await page.evaluate(() => document.documentElement.dataset.theme));
console.log("stored          =", await page.evaluate(() => localStorage.getItem("sapiom-harness-theme")));
console.log("iframe src      =", await page.locator("iframe.canvas-iframe").getAttribute("src"));
console.log("iframe srcdoc?  =", (await page.locator("iframe.canvas-iframe").getAttribute("srcdoc")) ? "yes" : "no");
console.log("canvas theme attr =", await page.frameLocator("iframe.canvas-iframe").locator(":root").getAttribute("data-canvas-theme"));
await page.screenshot({ path: process.argv[3] });
await browser.close();
