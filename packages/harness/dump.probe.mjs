import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto(process.argv[2], { waitUntil: "networkidle" });
await p.waitForTimeout(5000);
console.log(JSON.stringify(await p.evaluate(() => ({
  groups: Array.from(document.querySelectorAll("[data-testid^='workspace-group-']")).map(e=>e.getAttribute("data-testid")),
  rows: Array.from(document.querySelectorAll(".workspace-row")).slice(0,20).map(e=>e.getAttribute("data-testid")),
  railText: (document.querySelector(".rail-tree")||{}).innerText?.slice(0,600),
  body: document.body.innerText.slice(0, 800),
})), null, 2));
await p.screenshot({ path: "/tmp/shots-2982/dump.png" });
await b.close();
