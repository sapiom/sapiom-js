import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror",e=>console.log("PAGEERROR",e.message));
await p.goto("http://localhost:5463/?seed=0", { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
await p.getByTestId("right-tab-steps").click();
await p.waitForTimeout(500);
const dump = async (l) => console.log(l, JSON.stringify(await p.evaluate(() => {
  const q=(s)=>document.querySelector(s);
  const vis=(el)=>!!el&&!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
  return {
    rightPaneCls: q(".right-pane")?.className,
    snippets: !!q("[data-testid=steps-snippets]"),
    toggle: q("[data-testid=steps-snippets-toggle]")?.getAttribute("aria-expanded") ?? null,
    stepsSurface: !!q("[data-testid=canvas-steps-surface]"),
    session: q("[data-testid=session-context]")?.getAttribute("data-session-id"),
    focused: [...document.querySelectorAll(".workflow-item.is-focused")].map(e=>e.dataset.testid),
    paneText: q("[data-testid=right-panel-board]")?.textContent?.slice(0,180),
    steps: q("[data-testid=right-tab-steps]")?.getAttribute("aria-selected"),
  };
})));
await dump("initial leasing steps:");
// focus rfq
await p.getByTestId("workflow-rfq").locator(".workspace-row-main").click().catch(async()=>{ await p.getByTestId("workflow-rfq").click(); });
await p.waitForTimeout(2000);
await dump("rfq:");
await p.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
await p.waitForTimeout(2500);
await dump("back to leasing:");
await b.close();
