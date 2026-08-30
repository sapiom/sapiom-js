import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto(process.argv[2], { waitUntil: "networkidle" });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(() => ({
  projectRows: [...document.querySelectorAll("[data-testid^=project-]")].map(e=>e.dataset.testid),
  groups: [...document.querySelectorAll("[data-testid^=workspace-group-]")].map(e=>e.dataset.testid),
  railText: document.querySelector(".rail-workflows")?.textContent?.slice(0,300),
})), null, 1));
await p.screenshot({ path: "/tmp/shots-2980/rail.png" });
await b.close();
