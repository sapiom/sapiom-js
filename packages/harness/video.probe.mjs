import { chromium } from "@playwright/test";
const URL = process.argv[2], TAG = process.argv[3];
const DIR = `/tmp/shots-2982/video-${TAG}`;
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1500, height: 950 },
  recordVideo: { dir: DIR, size: { width: 1500, height: 950 } },
});
const p = await ctx.newPage();
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
if (await p.locator("[data-testid=help-overlay-dismiss]").count()) {
  await p.locator("[data-testid=help-overlay-dismiss]").click();
  await p.waitForTimeout(600);
}
for (const label of ["team-bots", "murderbox"]) {
  const group = p.locator(`[data-testid='workspace-group-${label}']`);
  const main = group.locator(":scope > .workspace-row .workspace-row-main").first();
  await main.scrollIntoViewIfNeeded();
  await main.hover();
  await p.waitForTimeout(900);
  await main.dblclick();
  await p.waitForTimeout(1400);
  await main.dblclick();
  await p.waitForTimeout(1400);
}
await ctx.close();
await b.close();
console.log("video in", DIR);
