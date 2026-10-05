import { chromium } from "playwright";
const S = process.env.S, URL = process.env.URL, T = `${S}/r5s-tree`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(URL);
await page.locator(".rail-workflows").waitFor();
if (await page.getByTestId("help-overlay").count()) {
  await page.keyboard.press("Escape");
  await page.getByTestId("help-overlay").waitFor({ state: "detached" });
}
for (const p of ["proj-a", "proj-b", "proj-c"]) {
  await page.getByTestId("rail-add-project").click();
  await page.getByTestId("folder-field-input").fill(`${T}/${p}`);
  await page.getByTestId("project-folder-continue").click();
  await page.getByTestId("project-folder-dialog").waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: `${S}/shots-r5s/added.png` });
console.log(await page.locator("[data-testid^=project-select-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid"))));
await browser.close();
