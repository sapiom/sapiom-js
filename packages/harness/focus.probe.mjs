import { chromium } from "@playwright/test";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto(process.argv[2], { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
console.log(JSON.stringify(await p.evaluate(() => {
  const a = document.activeElement;
  const cs = getComputedStyle(a);
  return {
    cls: a.className,
    outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
    matchesFocusVisible: a.matches(":focus-visible"),
    boxShadow: cs.boxShadow,
  };
}), null, 2));
await p.screenshot({ path: "/tmp/shots-2982/focus-check.png", clip: {x:600,y:300,width:900,height:650} });
await b.close();
