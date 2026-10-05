import { chromium } from "playwright";
const S = process.env.S, URL = process.env.URL;
const browser = await chromium.launch();
for (const [label, name] of JSON.parse(process.env.CASES)) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: process.env.SCHEME ?? "light" });
  await page.addInitScript((t) => localStorage.setItem("sapiom-harness-theme", t), process.env.SCHEME ?? "light");
  await page.goto(URL);
  await page.locator(".rail-workflows").waitFor();
  const row = page.getByTestId(`project-select-${label}`);
  await row.hover();
  await page.getByTestId(`project-new-chat-${label}`).click();
  await page.mouse.move(900, 700);
  await page.waitForTimeout(15000);
  const text = (await page.locator(".xterm-rows").allInnerTexts()).join("\n");
  console.log(`== ${name} (${label})\n`, text.replace(/\s+\n/g, "\n").slice(0, 1200));
  console.log("trust prompt shown:", /trust this folder|Quick safety check/i.test(text));
  await page.screenshot({ path: `${S}/shots-r5s/session-${name}.png` });
  await page.close();
}
await browser.close();
