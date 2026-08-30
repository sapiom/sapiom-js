import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message, "\n", e.stack?.split("\n").slice(0,6).join("\n")));
p.on("console", (m) => { if (m.type()==="error") console.log("CONSOLE", m.text().slice(0,400)); });
await p.goto(process.argv[2], { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
console.log(await p.evaluate(() => document.body.innerText.slice(0, 400)));
await b.close();
