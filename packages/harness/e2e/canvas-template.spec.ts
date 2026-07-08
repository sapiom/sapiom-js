import { test, expect } from "@playwright/test";
import { renderCanvasHtml, type CanvasData } from "../src/core/canvas-template.js";

const ORDER_TRIAGE: CanvasData = {
  version: 1,
  graphs: [
    {
      id: "order-triage",
      title: "order-triage",
      subtitle: "Support-ticket triage: intake -> classify -> route, then auto-resolve or escalate.",
      badges: ["standalone workflow"],
      stats: [
        { label: "steps", value: 5 },
        { label: "terminal outcomes", value: 2 },
        { label: "branch points", value: 1 },
      ],
      nodes: [
        { id: "intake", kind: "entry", label: "intake", sublabel: "receive + log order" },
        { id: "classify", kind: "step", label: "classify", sublabel: 'category ?? "general"' },
        { id: "review", kind: "pause", label: "review", sublabel: "waits for a human tag" },
        { id: "route", kind: "step", label: "route", sublabel: "branch on category" },
        { id: "auto_resolve", kind: "terminal-success", label: "auto_resolve", sublabel: "terminate({resolved:true})" },
        { id: "escalate", kind: "terminal-warn", label: "escalate", sublabel: "terminate({escalated:true})" },
      ],
      edges: [
        { from: "intake", to: "classify", kind: "sequential" },
        { from: "classify", to: "review", kind: "sequential" },
        { from: "review", to: "route", kind: "sequential" },
        { from: "route", to: "auto_resolve", kind: "branching", label: "category != billing" },
        { from: "route", to: "escalate", kind: "branching", label: "billing_dispute" },
      ],
    },
  ],
  interconnections: [
    { from: "external", to: "order-triage.intake", kind: "signal", label: "an order object enters here" },
    { from: "order-triage.escalate", to: "external", kind: "handoff", label: "routes to a human out-of-band" },
  ],
  note: "Static preview — regenerate after the workflow changes.",
};

const WORKSPACE_OVERVIEW: CanvasData = {
  version: 1,
  graphs: [
    { id: "a", title: "workflow-a", nodes: [{ id: "n1", kind: "entry", label: "start" }], edges: [] },
    { id: "b", title: "workflow-b", nodes: [{ id: "n1", kind: "terminal-success", label: "done" }], edges: [] },
  ],
  interconnections: [{ from: "a.n1", to: "b.n1", kind: "handoff", label: "a hands off to b" }],
};

for (const theme of ["light", "dark"] as const) {
  test(`renders order-triage with no console errors and correct theme (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.setContent(renderCanvasHtml(ORDER_TRIAGE), { baseURL: `http://canvas.test/?theme=${theme}` });
    // setContent() doesn't navigate, so the query-param theme script (which
    // reads location.search) never runs — apply the same attribute directly
    // to prove the CSS itself responds to it, independent of how it's set.
    await page.evaluate((t) => document.documentElement.setAttribute("data-canvas-theme", t), theme);

    await expect(page.locator(".canvas-title")).toHaveText("order-triage");
    // 6 nodes -> 6 rendered rects.
    await expect(page.locator("rect.canvas-node-rect")).toHaveCount(6);
    // 5 structural edges.
    await expect(page.locator("path.canvas-edge")).toHaveCount(5);
    // Legend covers every node kind actually used (entry/step/pause/terminal-success/terminal-warn = 5)
    // plus the cross-workflow marker for the two interconnections.
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
  await page.setContent(renderCanvasHtml(WORKSPACE_OVERVIEW));
  await expect(page.locator(".canvas-panel").filter({ has: page.locator(".canvas-title") })).toHaveCount(2);
  await expect(page.locator(".canvas-interconnection-row")).toHaveCount(1);
  await expect(page.locator(".canvas-interconnection-title")).toHaveText("start → done");
});

test("renders the empty state without throwing when there are no graphs yet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.setContent(renderCanvasHtml({ version: 1, graphs: [], note: "Nothing visualized yet." }));
  await expect(page.locator(".canvas-empty-text")).toHaveText("Nothing visualized yet.");
  expect(errors).toEqual([]);
});

test("hand-editing only the data block, byte-for-byte, still renders correctly", async ({ page }) => {
  // This is the literal contract the visualize macro's prompt relies on:
  // an agent (or here, a raw string edit) touches ONLY the JSON between the
  // <script id="canvas-data"> tags — every other byte of the document,
  // including the schema comment and the renderer script, is untouched —
  // and the file still renders the new data correctly.
  const original = renderCanvasHtml(ORDER_TRIAGE);
  const edited: CanvasData = {
    version: 1,
    graphs: [
      { id: "x", title: "renamed-flow", nodes: [{ id: "only", kind: "terminal-success", label: "done" }], edges: [] },
    ],
  };
  const dataBlock = /<script type="application\/json" id="canvas-data">\n[\s\S]*?\n<\/script>/;
  const originalMatch = original.match(dataBlock);
  expect(originalMatch, "canvas-data script block must be present in the rendered document").toBeTruthy();
  const mutated = original.replace(dataBlock, `<script type="application/json" id="canvas-data">\n${JSON.stringify(edited, null, 2)}\n</script>`);
  const mutatedMatch = mutated.match(dataBlock);
  expect(mutatedMatch, "canvas-data script block must survive the edit").toBeTruthy();
  // Confirm the surgery really did leave everything else byte-identical —
  // this is the actual claim under test, not just "some HTML renders". Strip
  // each string's own data block out before comparing, since the two blocks
  // necessarily differ (that's the edit) but nothing else should.
  expect(mutated.replace(mutatedMatch![0], "")).toBe(original.replace(originalMatch![0], ""));

  await page.setContent(mutated);
  await expect(page.locator(".canvas-title")).toHaveText("renamed-flow");
  await expect(page.locator("rect.canvas-node-rect")).toHaveCount(1);
});
