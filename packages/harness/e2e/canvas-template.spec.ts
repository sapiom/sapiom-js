import { test, expect } from "@playwright/test";
import { TEMPLATE_HTML, renderCanvasDocument } from "../src/core/canvas-template.js";

/**
 * A representative filled-in canvas body — the shape an agent following the
 * visualize macro's prompt produces after cloning `_template.html` and
 * using its documented node/edge patterns. Kept independent of
 * scripts/seed-example.mjs (which has scaffold side effects on import) but
 * intentionally mirrors the same order-triage workflow for consistency.
 */
const ORDER_TRIAGE_BODY = `
<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">order-triage</h1>
      <span class="canvas-badge">standalone workflow</span>
    </div>
    <p class="canvas-subtitle">Support-ticket triage: intake -&gt; classify -&gt; route, then auto-resolve or escalate.</p>
    <div class="canvas-stats">
      <div class="canvas-stat"><span class="canvas-stat-value">6</span><span class="canvas-stat-label">steps</span></div>
      <div class="canvas-stat"><span class="canvas-stat-value">2</span><span class="canvas-stat-label">terminal outcomes</span></div>
      <div class="canvas-stat"><span class="canvas-stat-value">1</span><span class="canvas-stat-label">branch points</span></div>
    </div>
  </header>
  <div class="canvas-diagram-panel">
    <svg class="canvas-graph-svg" viewBox="0 0 960 610" xmlns="http://www.w3.org/2000/svg">
      <path class="canvas-edge" d="M480,96 L480,150" marker-end="url(#canvas-arrow)" />
      <path class="canvas-edge" d="M480,206 L480,260" marker-end="url(#canvas-arrow)" />
      <path class="canvas-edge" d="M480,316 L480,370" marker-end="url(#canvas-arrow)" />
      <path class="canvas-edge canvas-edge--success" d="M480,426 C480,470 288,470 288,520" marker-end="url(#canvas-arrow-success)" />
      <path class="canvas-edge canvas-edge--warn" d="M480,426 C480,470 688,470 688,520" marker-end="url(#canvas-arrow-warn)" />
      <text class="canvas-edge-label" x="440" y="455" text-anchor="end">category != billing</text>
      <text class="canvas-edge-label" x="520" y="455" text-anchor="start">billing_dispute</text>

      <g class="canvas-node node--entry" filter="url(#canvas-glow)" transform="translate(392,40)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">intake</text>
        <text class="canvas-node-sub" x="88" y="40">receive + log order</text>
      </g>
      <g class="canvas-node node--step" filter="url(#canvas-glow)" transform="translate(392,150)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">classify</text>
        <text class="canvas-node-sub" x="88" y="40">category ?? "general"</text>
      </g>
      <g class="canvas-node node--pause" filter="url(#canvas-glow)" transform="translate(392,260)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">review</text>
        <text class="canvas-node-sub" x="88" y="40">waits for a human tag</text>
      </g>
      <g class="canvas-node node--step" filter="url(#canvas-glow)" transform="translate(392,370)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">route</text>
        <text class="canvas-node-sub" x="88" y="40">branch on category</text>
      </g>
      <g class="canvas-node node--terminal-success" filter="url(#canvas-glow)" transform="translate(200,520)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">auto_resolve</text>
        <text class="canvas-node-sub" x="88" y="40">terminate({resolved:true})</text>
      </g>
      <g class="canvas-node node--terminal-warn" filter="url(#canvas-glow)" transform="translate(600,520)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">escalate</text>
        <text class="canvas-node-sub" x="88" y="40">terminate({escalated:true})</text>
      </g>
    </svg>
  </div>
</section>

<section class="canvas-panel canvas-interconnections">
  <h2 class="canvas-panel-title">Interconnections</h2>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--entry"></span>
    <span class="canvas-interconnection-title">external -&gt; intake</span>
    <span class="canvas-interconnection-tag">signal</span>
    <p class="canvas-interconnection-desc">an order object enters here</p>
  </div>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>
    <span class="canvas-interconnection-title">escalate -&gt; external</span>
    <span class="canvas-interconnection-tag">handoff</span>
    <p class="canvas-interconnection-desc">routes to a human out-of-band</p>
  </div>
</section>

<footer class="canvas-footer">
  <div class="canvas-legend">
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--entry"></span>entry / active step</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--step"></span>step</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--pause"></span>pause / waits for input</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-success"></span>terminal &middot; success</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>terminal &middot; escalation</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--cross"></span>cross-workflow signal/handoff</span>
  </div>
  <p class="canvas-note">Static preview — regenerate after the workflow changes.</p>
</footer>
`.trim();

const WORKSPACE_OVERVIEW_BODY = `
<section class="canvas-panel">
  <header class="canvas-header"><div class="canvas-title-row"><h1 class="canvas-title">workflow-a</h1></div></header>
  <div class="canvas-diagram-panel">
    <svg class="canvas-graph-svg" viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
      <g class="canvas-node node--entry" filter="url(#canvas-glow)" transform="translate(20,20)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="28">start</text>
      </g>
    </svg>
  </div>
</section>
<section class="canvas-panel">
  <header class="canvas-header"><div class="canvas-title-row"><h1 class="canvas-title">workflow-b</h1></div></header>
  <div class="canvas-diagram-panel">
    <svg class="canvas-graph-svg" viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
      <g class="canvas-node node--terminal-success" filter="url(#canvas-glow)" transform="translate(20,20)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="28">done</text>
      </g>
    </svg>
  </div>
</section>
<section class="canvas-panel canvas-interconnections">
  <h2 class="canvas-panel-title">Interconnections</h2>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>
    <span class="canvas-interconnection-title">start -&gt; done</span>
    <span class="canvas-interconnection-tag">handoff</span>
    <p class="canvas-interconnection-desc">a hands off to b</p>
  </div>
</section>
`.trim();

for (const theme of ["light", "dark"] as const) {
  test(`renders a filled-in order-triage canvas with no console errors and correct theme (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.setContent(renderCanvasDocument(ORDER_TRIAGE_BODY));
    // setContent() doesn't navigate, so the query-param theme script (which
    // reads location.search) never runs — apply the same attribute directly
    // to prove the CSS itself responds to it, independent of how it's set.
    await page.evaluate((t) => document.documentElement.setAttribute("data-canvas-theme", t), theme);

    await expect(page.locator(".canvas-title")).toHaveText("order-triage");
    // 6 nodes -> 6 rendered rects.
    await expect(page.locator("rect.canvas-node-rect")).toHaveCount(6);
    // 5 structural edges.
    await expect(page.locator("path.canvas-edge")).toHaveCount(5);
    // Legend covers every node kind used (entry/step/pause/terminal-success/terminal-warn = 5)
    // plus the cross-workflow marker.
    await expect(page.locator(".canvas-legend-item")).toHaveCount(6);
    await expect(page.locator(".canvas-interconnection-row")).toHaveCount(2);

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (theme === "dark") {
      expect(bg).toBe("rgb(15, 15, 15)"); // #0f0f0f
    } else {
      expect(bg).toBe("rgb(243, 244, 246)"); // #f3f4f6
    }

    expect(errors).toEqual([]);
    await page.screenshot({ path: `e2e/test-results/canvas-order-triage-${theme}.png`, fullPage: true });
  });
}

test("renders a multi-graph workspace overview with cross-graph interconnections", async ({ page }) => {
  await page.setContent(renderCanvasDocument(WORKSPACE_OVERVIEW_BODY));
  await expect(page.locator(".canvas-panel").filter({ has: page.locator(".canvas-title") })).toHaveCount(2);
  await expect(page.locator(".canvas-interconnection-row")).toHaveCount(1);
  await expect(page.locator(".canvas-interconnection-title")).toHaveText("start -> done");
});

test("the pristine template renders its friendly empty state, with zero visible nodes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.setContent(TEMPLATE_HTML);
  await expect(page.locator(".canvas-empty-note")).toHaveText(/nothing visualized yet/i);
  // The <template id="canvas-patterns"> block documents one example of
  // every node/edge kind, but <template> content is inert (lives in a
  // DocumentFragment, not the live DOM) — it must never render as if it
  // were a real graph.
  await expect(page.locator(".canvas-node")).toHaveCount(0);
  await expect(page.locator(".canvas-legend-item")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the pristine template's patterns are readable as raw markup for an agent to copy, even though inert", async ({ page }) => {
  await page.setContent(TEMPLATE_HTML);
  // Confirm the pattern content actually exists in the template's parsed
  // fragment (not just absent/typo'd) — read it back out via .content.
  const patternHtml = await page.evaluate(() => {
    const tpl = document.getElementById("canvas-patterns") as HTMLTemplateElement;
    return tpl.content.querySelectorAll(".canvas-node").length;
  });
  expect(patternHtml).toBe(5); // one example per node kind
});
