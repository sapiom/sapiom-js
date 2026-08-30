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
    tabLabels: [...document.querySelectorAll(".session-tab-label")].map((t) => t.textContent.trim()),
    boardVisible: vis(q("[data-testid=right-panel-board]")),
    boardSubject: q(".workflow-actions-name")?.textContent ?? null,
    subjectName: q("[data-testid=session-subject-name]")?.textContent ?? q(".session-subject-name")?.textContent ?? null,
    railFocused: [...document.querySelectorAll(".workflow-item.is-focused, .is-focused")].map((e) => e.dataset.testid).filter(Boolean),
    railSelectedProject: [...document.querySelectorAll("[data-testid^=project-row-].is-selected")].map((e) => e.dataset.testid),
    up: q("[data-testid=canvas-altitude-up]")?.getAttribute("aria-label") ?? null,
    terminalVisible: vis(q(".harness-terminal")),
    centerVisible: vis(q(".center-pane")),
    stepsDisabled: q("[data-testid=right-tab-steps]")?.disabled ?? null,
  };
});
const step = async (label) => { const s = await snap(); console.log(label, JSON.stringify(s)); return s; };

const openProject = async (name) => {
  await p.locator(`[data-testid="project-select-${name}"]`).first().click();
  await p.waitForTimeout(3000);
};

console.log("--- E3.2 team-bots (no live session) ---");
await openProject("team-bots");
const teamBots = await step("teamBots");
await p.screenshot({ path: "/tmp/shots-2980/e32-team-bots.png" });

console.log("--- E3.1/E3.3 murderbox ---");
await openProject("murderbox");
const mb = await step("murderbox");
await p.screenshot({ path: "/tmp/shots-2980/e31-murderbox.png" });

console.log("--- E3.4 select an agent INSIDE murderbox ---");
// expand the project disclosure and pick an agent row
await p.locator('[data-testid="project-disclosure-murderbox"]').first().click().catch(()=>{});
await p.waitForTimeout(800);
const agentRows = await p.evaluate(() => [...document.querySelectorAll("[data-testid^=workflow-]")].map(e=>e.dataset.testid).slice(0,30));
console.log("agent rows:", agentRows);
const pick = agentRows.find((t) => !t.includes("@sapiom"));
await p.locator(`[data-testid="${pick}"] .workflow-item-trigger`).first().click();
await p.waitForTimeout(2500);
const afterAgent = await step("afterAgent");
await p.screenshot({ path: "/tmp/shots-2980/e34-agent-in-murderbox.png" });
console.log("SESSION MOVED?", mb.sessionId !== afterAgent.sessionId, mb.sessionId, "->", afterAgent.sessionId);
console.log("TABS SAME?", JSON.stringify(mb.tabIds) === JSON.stringify(afterAgent.tabIds));

console.log("--- E3.7 back up to the map, then drill from a node ---");
await p.locator('[data-testid="canvas-altitude-up"]').click();
await p.waitForTimeout(2500);
const backUp = await step("backUp");
await p.screenshot({ path: "/tmp/shots-2980/e37-back-to-map.png" });
const nodes = await p.evaluate(() => [...document.querySelectorAll("[data-testid^=system-graph-node-]")].map(e=>e.dataset.testid));
console.log("map nodes:", nodes);
if (nodes[0]) {
  await p.locator(`[data-testid="${nodes[0]}"]`).click();
  await p.waitForTimeout(2500);
  const drilled = await step("drilled");
  await p.screenshot({ path: "/tmp/shots-2980/e37-drilled.png" });
  console.log("DRILL SESSION MOVED?", backUp.sessionId !== drilled.sessionId);
}

console.log("--- E3.5 cross to outreach ---");
await openProject("outreach");
const outreach = await step("outreach");
await p.screenshot({ path: "/tmp/shots-2980/e35-outreach.png" });
console.log("HANDOVER?", outreach.sessionId !== mb.sessionId, mb.sessionId, "->", outreach.sessionId);

console.log("ERRORS:", errs);
await ctx.close();
await b.close();
