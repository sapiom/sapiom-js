import { chromium } from "@playwright/test";
const URL = process.argv[2];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const out = {};
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
out.firstLoad = await p.locator("[data-testid=help-overlay]").count();
await p.screenshot({ path: "/tmp/shots-2982/after-explainer.png" });
out.storedBeforeDismiss = await p.evaluate(() => localStorage.getItem("sapiom-harness-help-seen"));
await p.locator("[data-testid=help-overlay-dismiss]").click();
await p.waitForTimeout(500);
out.storedAfterDismiss = await p.evaluate(() => localStorage.getItem("sapiom-harness-help-seen"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(3500);
out.afterReload = await p.locator("[data-testid=help-overlay]").count();
// Third load, brand new page in the SAME context (same storage).
const p2 = await ctx.newPage();
await p2.goto(URL, { waitUntil: "networkidle" });
await p2.waitForTimeout(3500);
out.afterNewTab = await p2.locator("[data-testid=help-overlay]").count();
// Re-open from the account menu.
await p.bringToFront();
await p.locator("[data-testid=brand-identity]").click();
await p.waitForTimeout(400);
await p.locator("[data-testid=rail-help]").click();
await p.waitForTimeout(600);
out.reopened = await p.locator("[data-testid=help-overlay]").count();
await p.screenshot({ path: "/tmp/shots-2982/after-explainer-reopened.png" });
// Contrast: does the note stand out without a brand surface?
out.noteStyles = await p.locator("[data-testid=help-upgrade-note]").evaluate((e) => {
  const cs = getComputedStyle(e);
  return { background: cs.backgroundColor, color: cs.color, padding: cs.padding };
});
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
out.afterEscape = await p.locator("[data-testid=help-overlay]").count();
console.log(JSON.stringify(out, null, 2));
await b.close();
