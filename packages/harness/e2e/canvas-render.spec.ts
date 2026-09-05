/**
 * Canvas RENDER e2e — the generated document, in a real browser.
 *
 * canvas-template.spec.ts renders hand-written bodies to prove the template's
 * CSS/markup contract. src/core/canvas-render.test.ts asserts the *strings* the
 * renderer produces. Neither ever loads what the renderer actually generates
 * into a page — so an assembly bug (unclosed panel, unresolved placeholder,
 * markup that parses but paints nothing) passes both and only shows up as an
 * empty Canvas iframe in front of a user.
 *
 * These tests run the real pipeline (`renderCanvasForSession` over the same
 * fixtures the unit tests use), then NAVIGATE to the written file with
 * `file://` — not `setContent` — so the document's own inline theme script runs
 * against `location.search`, exactly as the SPA's iframe loads it.
 */
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { clearExtractionCache } from "../src/core/canvas-cache.js";
import { renderCanvasForSession, renderFileFor, type RenderableWorkflow } from "../src/core/canvas-render.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "__fixtures__");
const ORDER_TRIAGE = path.join(FIXTURES_DIR, "order-triage");
const NO_DEFINITION = path.join(FIXTURES_DIR, "no-definition");
const HUB = path.join(FIXTURES_DIR, "hub");

/** Workflow extraction bundles with esbuild — slower than a DOM assertion. */
test.setTimeout(60_000);

const tmpDirs: string[] = [];
test.afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/**
 * Renders `workflowPath` through the production path and returns the file URL of
 * the document that got written — the artifact the Canvas iframe would load.
 */
async function renderToFileUrl(workflowPath: string, name: string, query = ""): Promise<{ url: string; file: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-render-e2e-"));
  tmpDirs.push(cwd);
  clearExtractionCache();
  const workflows: RenderableWorkflow[] = [{ path: workflowPath, name, definitionId: null }];
  const outcome = await renderCanvasForSession({ cwd, boundWorkflowPath: workflowPath }, workflows);
  expect(outcome.mode).toBe("single");
  const file = renderFileFor(cwd, workflowPath);
  return { url: `${pathToFileURL(file).href}${query}`, file };
}

for (const theme of ["light", "dark"] as const) {
  test(`the generated order-triage document paints its graph and honors ?theme=${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    const { url } = await renderToFileUrl(ORDER_TRIAGE, "order-triage", `?theme=${theme}`);
    await page.goto(url);

    // Every step the extractor found is *visible*, not merely present in the
    // markup — the unit test can only assert the latter.
    for (const step of ["intake", "classify", "route", "auto_resolve", "escalate"]) {
      await expect(page.locator(".canvas-node-title", { hasText: new RegExp(`^${step}$`) })).toBeVisible();
    }
    // A graph that paints: rects and edges actually laid out inside the SVG.
    const rects = page.locator("rect.canvas-node-rect");
    await expect(rects.first()).toBeVisible();
    expect(await rects.count()).toBeGreaterThanOrEqual(5);
    expect(await page.locator("path.canvas-edge").count()).toBeGreaterThanOrEqual(4);
    await expect(page.locator(".canvas-legend-item").first()).toBeVisible();

    // Real navigation (not setContent) means the document's own inline script
    // read ?theme= and applied it — the path the SPA iframe uses.
    await expect(page.locator("html")).toHaveAttribute("data-canvas-theme", theme);

    // The SVG has non-zero layout: a document that parses but collapses to
    // nothing is the failure mode string assertions can't see.
    const box = await page.locator("svg.canvas-graph-svg").first().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    expect(errors).toEqual([]);
    await page.screenshot({ path: `e2e/test-results/canvas-render-order-triage-${theme}.png`, fullPage: true });
  });
}

test("the generated document defaults to light even when the OS prefers dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const { url } = await renderToFileUrl(ORDER_TRIAGE, "order-triage");
  await page.goto(url);

  await expect(page.locator("html")).toHaveAttribute("data-canvas-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgb(255, 255, 255)",
  );
});

test("the generated document leaves no unresolved template placeholders", async ({ page }) => {
  const { url, file } = await renderToFileUrl(ORDER_TRIAGE, "order-triage");
  await page.goto(url);
  const html = await fs.readFile(file, "utf8");
  // `{{...}}` is the template/macro placeholder syntax; any survivor in the
  // written document means an assembly step didn't substitute.
  expect(html).not.toMatch(/\{\{[^}]+\}\}/);
  // Nor should the visible text ever show raw markup or "undefined"/"NaN" from
  // a missing field.
  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  expect(bodyText).not.toContain("undefined");
  expect(bodyText).not.toContain("nan");
});

test("a workflow with no extractable definition renders an honest error panel, not a fake graph", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const { url } = await renderToFileUrl(NO_DEFINITION, "no-definition");
  await page.goto(url);

  // The error panel is the answer the user asked for — it must be readable…
  await expect(page.locator(".canvas-panel").first()).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text.length).toBeGreaterThan(20);
  // …and it must NOT invent a diagram.
  await expect(page.locator("rect.canvas-node-rect")).toHaveCount(0);
  expect(errors).toEqual([]);
});

/**
 * SAP-3199. Embedded, the SPA draws its own Render-failed card (short claim,
 * one-line reason, actions, full reason behind Details) as a TRANSPARENT layer
 * over this document. So the composed view has exactly one error message only if
 * the document stands its own prose down while it is framed. It used to keep
 * painting, and the short reason and the long one drew through each other.
 *
 * The parent here is a bare file:// shell rather than the real SPA: it loads the
 * render the same way (an `allow-scripts`-only sandboxed iframe) and listens on
 * the same channel, which is all the document can observe. Asserting against the
 * real app is the screenshot pass on the PR, not this spec.
 */
async function embedInParentShell(page: Page, url: string, file: string): Promise<FrameLocator> {
  const parentFile = path.join(path.dirname(file), "workbench-shell.html");
  await fs.writeFile(
    parentFile,
    `<!doctype html><html><body style="margin:0">
<script>
  window.__posted = [];
  addEventListener("message", function (e) {
    if (e.data && e.data.type === "sapiom-canvas:error") window.__posted.push(e.data);
  });
</script>
<iframe id="board" sandbox="allow-scripts" src="${url}" style="width:900px;height:600px;border:0"></iframe>
</body></html>`,
    "utf8",
  );
  await page.goto(pathToFileURL(parentFile).href);
  return page.frameLocator("#board");
}

/** The opening of the failed panel's prose, which is the string that used to
 *  draw through the app's card. */
const REASON_TEXT = /Could not extract this agent's step graph/;

test("an embedded failed render shows one error message, not two drawn through each other", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const { url, file } = await renderToFileUrl(NO_DEFINITION, "no-definition");
  const frame = await embedInParentShell(page, url, file);

  // The reason reaches the workbench exactly once, which is the one message the
  // user is shown, and the SPA renders it as the card.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted.length))
    .toBe(1);
  const posted = await page.evaluate(
    () => (window as unknown as { __posted: { title: string; reason: string }[] }).__posted[0],
  );
  expect(posted.title).toBe("no-definition");
  expect(posted.reason.length).toBeGreaterThan(10);

  // …and the document under the card paints no second copy of it. Restore the
  // overlap (drop the class or the stylesheet rule) and this is the assertion
  // that goes red.
  await expect(frame.locator(".canvas-render-error-note")).toBeAttached();
  await expect(frame.getByText(REASON_TEXT)).toBeHidden();
  // Nothing else in the document paints a message either. Every text-bearing
  // element is walked rather than the two we know about, so a THIRD string added
  // to the failed panel later cannot quietly reintroduce the overlap.
  //
  // "Paints" is hit-tested rather than inferred from the box, because the title
  // and the "render failed" badge would otherwise count: they live in
  // `.canvas-header`, which the template collapses to a clipped 1px box, and the
  // children inside it keep their full-size rects even though the parent clips
  // every pixel of them away. Asking the document what is actually at the
  // element's centre point is the question a reader asks.
  const painted = await frame.locator("body").evaluate((body) => {
    const shown: string[] = [];
    for (const el of Array.from(body.querySelectorAll<HTMLElement>("p, h1, span, div"))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent || "").trim())
        .join(" ")
        .trim();
      if (!own) continue;
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit && (hit === el || el.contains(hit))) shown.push(own);
    }
    return shown;
  });
  expect(painted).toEqual([]);
  expect(errors).toEqual([]);
});

test("a failed render opened on its own keeps its prose as the only message", async ({ page }) => {
  const { url } = await renderToFileUrl(NO_DEFINITION, "no-definition");
  await page.goto(url);

  // No parent, so no card is coming, and the document must still say what happened.
  await expect(page.getByText(REASON_TEXT)).toBeVisible();
  expect(await page.getByText(REASON_TEXT).count()).toBe(1);
});

test("launched sub-workflows paint as their own dashed nodes with a launch edge", async ({ page }) => {
  const { url } = await renderToFileUrl(HUB, "hub");
  await page.goto(url);

  // The launched-workflow node is a distinct visual kind (dashed) — assert it
  // renders as such, since the unit test can only see the class name.
  const launched = page.locator(".canvas-node.node--launched-workflow");
  await expect(launched.first()).toBeVisible();
  await expect(page.locator(".canvas-node-title", { hasText: /^spoke-workflow$/ })).toBeVisible();

  // NOT toBeVisible(): a straight vertical edge has a zero-WIDTH bounding box,
  // which Playwright reports as hidden even though it paints. Assert what
  // actually makes it appear — real geometry and a drawn stroke.
  const launchEdge = page.locator("path.canvas-edge--launch").first();
  await expect(launchEdge).toBeAttached();
  const edge = await launchEdge.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      length: (el as SVGPathElement).getTotalLength(),
      stroke: style.stroke,
      opacity: Number(style.opacity),
      dash: style.strokeDasharray,
    };
  });
  expect(edge.length).toBeGreaterThan(10);
  expect(edge.stroke).not.toBe("none");
  expect(edge.opacity).toBeGreaterThan(0);
  // A launch is a *dashed* edge — the visual distinction from a normal
  // transition, which a class-name assertion can't verify.
  expect(edge.dash === "" || edge.dash === "none").toBe(false);
});
