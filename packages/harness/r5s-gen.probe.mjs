import { chromium } from "playwright";
const S = process.env.S, URL = process.env.URL;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL);
await page.locator(".rail-workflows").waitFor();
for (const p of ["proj-c", "proj-a"]) {
  await page.getByTestId(`project-select-r5s-tree/${p}`).click();
  await page.waitForTimeout(2000);
  const retry = page.getByRole("button", { name: "Retry generation" });
  if (await retry.count()) await retry.click();
  await page.locator("[data-testid^=agent-map-node-]").first().waitFor({ timeout: 180000 }).catch(() => {});
  console.log(p, await page.locator("[data-testid^=agent-map-node-]").count(), "nodes");
}
await browser.close();
