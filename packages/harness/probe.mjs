import { chromium } from "@playwright/test";
const URL = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
const errs = [];
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE " + m.text().slice(0, 200)); });
await p.goto(URL, { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

const dump = async (label) => {
  const d = await p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const app = q(".app");
    return {
      gridCols: app ? getComputedStyle(app).gridTemplateColumns : null,
      appClass: app?.className ?? null,
      centerPane: { present: !!q(".center-pane"), visible: vis(q(".center-pane")), box: box(q(".center-pane")), inert: q(".center-pane")?.hasAttribute("inert") ?? null },
      rightPane: { present: !!q(".right-pane"), visible: vis(q(".right-pane")), box: box(q(".right-pane")), inert: q(".right-pane")?.hasAttribute("inert") ?? null, cls: q(".right-pane")?.className ?? null },
      terminal: { present: !!q(".harness-terminal"), visible: vis(q(".harness-terminal")), box: box(q(".harness-terminal")) },
      map: { present: !!q("[data-testid=workspace-graph-view]"), visible: vis(q("[data-testid=workspace-graph-view]")), box: box(q("[data-testid=workspace-graph-view]")) },
      mapTitle: q(".workspace-graph-title")?.textContent ?? null,
      board: { present: !!q("[data-testid=right-panel-board]"), visible: vis(q("[data-testid=right-panel-board]")) },
      tabs: [...document.querySelectorAll(".right-pane-tab")].map((t) => ({ id: t.dataset.testid, sel: t.getAttribute("aria-selected"), disabled: t.disabled, tip: t.dataset.tooltip ?? null, box: box(t) })),
      codeTab: !!q("[data-testid=right-tab-code]"),
      up: q("[data-testid=canvas-altitude-up]") ? { label: q(".right-pane-up-label")?.textContent, box: box(q("[data-testid=canvas-altitude-up]")), aria: q("[data-testid=canvas-altitude-up]").getAttribute("aria-label") } : null,
      sessionTabs: [...document.querySelectorAll("[data-testid^=session-tab-]")].map((t) => t.textContent.trim()),
      sessionId: q("[data-testid=session-context]")?.getAttribute("data-session-id") ?? null,
      railSelected: [...document.querySelectorAll(".workspace-row.is-selected, [data-testid^=project-row-].is-selected")].map((e) => e.dataset.testid ?? e.className),
      railFocused: [...document.querySelectorAll(".is-focused")].map((e) => e.dataset.testid).filter(Boolean),
      centerState: ["open-agent-empty", "project-session-starting", "agent-view", "new-session-composer"].filter((t) => vis(q(`[data-testid=${t}]`))),
      nodes: [...document.querySelectorAll("[data-testid^=system-graph-node-]")].map((n) => n.dataset.testid),
    };
  });
  console.log("\n===== " + label + " =====");
  console.log(JSON.stringify(d, null, 1));
  return d;
};

await dump("boot");
await p.screenshot({ path: "/tmp/shots-2980/probe-boot.png" });

// Select the property-ops project row
const row = p.locator('[data-testid="project-select-property-ops"]');
console.log("project-select-property-ops count:", await row.count());
if (await row.count() === 0) {
  console.log("rail rows:", await p.evaluate(() => [...document.querySelectorAll("[data-testid^=project-]")].map(e=>e.dataset.testid).slice(0,40)));
}
await row.first().click();
await p.waitForTimeout(4000);
await dump("after select property-ops");
await p.screenshot({ path: "/tmp/shots-2980/probe-project.png" });
console.log("ERRORS:", errs);
await b.close();
