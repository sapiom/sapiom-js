import { chromium } from "playwright";
import { execSync } from "node:child_process";
const S = process.env.S, URL = process.env.URL, C = `${S}/r5s-tree/proj-c`;
const scheme = process.env.SCHEME ?? "light";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: scheme,
  ...(process.env.VIDEO ? { recordVideo: { dir: `${S}/video-r5s`, size: { width: 1440, height: 900 } } } : {}),
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.addInitScript((t) => localStorage.setItem("sapiom-harness-theme", t), scheme);
await page.goto(URL);
await page.locator(".rail-workflows").waitFor();
await page.getByTestId("project-select-r5s-tree/proj-c").click();
const node = page.locator("[data-testid^=agent-map-node-]").first();
await node.waitFor();
await node.click();
const input = page.getByTestId("map-card-composer").getByTestId("chat-input");
await input.fill(process.env.PROMPT);
await input.press("Enter");
const card = page.getByTestId("chat-card-handoff");
const submit = page.getByTestId("map-chat-overlay").getByTestId("chat-submit");
await page.waitForTimeout(3000);
await submit.and(page.locator(":not([data-pending=true])")).waitFor({ timeout: 240000 });
await page.waitForTimeout(1000);
console.log("handoff cards:", await card.count());
console.log("transcript:", (await page.getByTestId("map-chat-overlay").innerText()).slice(0, 2500));
console.log("git status:", JSON.stringify(execSync("git status --porcelain", { cwd: C }).toString()));
await page.screenshot({ path: `${S}/shots-r5s/after-handoff-${scheme}.png` });
if (process.env.START && (await card.count())) {
  await card.last().getByTestId("chat-handoff-start").click();
  await page.getByTestId("chat-handoff-open").last().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${S}/shots-r5s/after-started-${scheme}.png` });
  await page.getByTestId("chat-handoff-open").last().click();
  await page.waitForTimeout(15000);
  const term = await page.locator(".xterm-rows").allInnerTexts();
  console.log("terminal:", term.join("\n---\n").slice(0, 3000));
  await page.screenshot({ path: `${S}/shots-r5s/after-session-${scheme}.png` });
}
await context.close();
await browser.close();
