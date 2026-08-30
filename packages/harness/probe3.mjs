import { chromium } from "@playwright/test";
const URL = process.argv[2];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

const snap = () => p.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  return {
    altitude: vis(q("[data-testid=workspace-graph-view]")) ? "map" : "board",
    mapTitle: q(".workspace-graph-title")?.textContent ?? null,
    sessionId: q("[data-testid=session-context]")?.getAttribute("data-session-id") ?? null,
    tabIds: [...document.querySelectorAll(".session-tab")].map((t) => t.dataset.testid.replace("session-tab-","").slice(0,8)),
    railFocused: [...document.querySelectorAll(".workflow-item.is-focused")].map((e) => e.dataset.testid),
    up: q("[data-testid=canvas-altitude-up]")?.getAttribute("aria-label") ?? null,
  };
});

await p.locator('[data-testid="project-select-murderbox"]').first().click();
await p.waitForTimeout(3500);
const at = await snap(); console.log("murderbox map:", JSON.stringify(at));

// Agents rendered UNDER the murderbox project group, by their real path.
const mbAgents = await p.evaluate(() => {
  const group = document.querySelector('[data-testid="workspace-group-murderbox"]');
  return group ? [...group.querySelectorAll("[data-testid^=workflow-]")].map(e=>e.dataset.testid).filter(t=>!t.startsWith("workflow-name-")&&!t.startsWith("workflow-status-")) : [];
});
console.log("murderbox agent rows:", mbAgents.slice(0,6));
await p.locator(`[data-testid="${mbAgents[0]}"] .workflow-item-trigger`).first().click();
await p.waitForTimeout(2500);
const after = await snap(); console.log("after sibling select:", JSON.stringify(after));
console.log("E3.4 conversation stayed:", at.sessionId === after.sessionId, "| tabs identical:", JSON.stringify(at.tabIds) === JSON.stringify(after.tabIds), "| right pane moved:", at.altitude !== after.altitude);

// A SECOND sibling, still inside murderbox
await p.locator(`[data-testid="${mbAgents[1]}"] .workflow-item-trigger`).first().click();
await p.waitForTimeout(2000);
const after2 = await snap(); console.log("after 2nd sibling:", JSON.stringify(after2));
console.log("E3.4 again:", after.sessionId === after2.sessionId, after.railFocused, "->", after2.railFocused);
console.log("ERRORS:", errs);
await ctx.close(); await b.close();
